import { assessWithModel, PROMPT_VERSION_HASH, type AssessmentOutput, type Verdict } from './assessor';
import { codeChecks, counterfactual, decisionFacts, evidenceTampered } from './checks';
import { buildEvidencePack } from './evidence';
import type { CaseMaterial } from './material';

export const HUMAN_REVIEW_AMOUNT_USD = 100;
export const MIN_CONFIDENCE = 0.8;

export type Validation = { passed: boolean; problems: string[]; counterfactual_source: 'code' };

/**
 * Validate the model's answer in code. Anything that does not hold drops the verdict to INCONCLUSIVE:
 *  - every cited recorder seq and every violated clause id must exist, and a clause the code verified as
 *    PASS can't be named as violated
 *  - AGENT_FAULT needs a violated clause and either a code counterfactual (a compliant alternative
 *    existed) or a firewall VIOLATION (the agent acted outside the mandate)
 *  - BUYER_REMORSE and MERCHANT_FAULT can't name violated agent clauses
 *  - a non-INCONCLUSIVE verdict must cite at least one recorder entry
 * The counterfactual attached to the result is always the code's, never the model's.
 */
export function validate(m: CaseMaterial, out: AssessmentOutput, clauses: Map<string, string>, alternatives: number): Validation {
  const problems: string[] = [];
  const seqs = new Set(m.recorder.entries.map((e) => e.seq));
  for (const s of out.cited_entries) if (!seqs.has(s)) problems.push(`cited entry ${s} does not exist`);
  for (const c of out.violated_clauses) {
    if (!clauses.has(c)) problems.push(`clause ${c} is not in the mandate`);
    else if (clauses.get(c) === 'PASS') problems.push(`clause ${c} was verified as PASS by code, so it cannot be violated`);
  }
  if (out.verdict !== 'INCONCLUSIVE' && out.cited_entries.length === 0) problems.push('no recorder entry cited');
  if (out.verdict === 'AGENT_FAULT') {
    if (!out.violated_clauses.length) problems.push('AGENT_FAULT without a violated clause');
    const outside = m.order.firewall.violations.length > 0;
    if (!alternatives && !outside) problems.push('AGENT_FAULT, but code found no compliant alternative and no firewall violation');
  }
  if ((out.verdict === 'BUYER_REMORSE' || out.verdict === 'MERCHANT_FAULT') && out.violated_clauses.length) {
    problems.push(`${out.verdict} cannot name violated agent clauses (${out.violated_clauses.join(', ')})`);
  }
  if (out.verdict === 'BUYER_REMORSE' && m.order.firewall.decision !== 'PASS') problems.push('BUYER_REMORSE, but the purchase was not fully compliant at checkout (firewall ' + m.order.firewall.decision + ')');
  return { passed: problems.length === 0, problems, counterfactual_source: 'code' };
}

export type PipelineResult = Awaited<ReturnType<typeof runPipeline>>;

/** Code checks, counterfactual, injection scan, evidence pack; then the model (only if the evidence holds); then validation. */
export async function runPipeline(m: CaseMaterial, opts: { appeal?: boolean } = {}) {
  const checks = codeChecks(m);
  const cf = counterfactual(m);
  const facts = decisionFacts(m);
  const { pack, hash, flags } = buildEvidencePack(m, checks, cf, facts);
  const clauses = new Map(pack.mandate.clauses.map((c) => [c.id, c.code_status]));
  const tampered = evidenceTampered(checks);
  const amount = Number(m.order.total_value);

  let ai: Awaited<ReturnType<typeof assessWithModel>> | null = null;
  let validation: Validation;
  let verdict: Verdict;
  if (tampered) {
    // Untrustworthy evidence: no model call, straight to a human.
    validation = { passed: false, problems: checks.filter((c) => c.status === 'FAIL').map((c) => `code check ${c.id} failed: ${c.detail}`), counterfactual_source: 'code' };
    verdict = 'INCONCLUSIVE';
  } else {
    ai = await assessWithModel(pack);
    validation = validate(m, ai.output, clauses, cf.compliant_alternatives.length);
    verdict = validation.passed ? ai.output.verdict : 'INCONCLUSIVE';
  }

  const reasons: string[] = [];
  if (tampered) reasons.push('evidence failed code checks (tampered or missing)');
  if (ai && !validation.passed) reasons.push('model answer failed validation');
  if (verdict === 'INCONCLUSIVE') reasons.push('verdict is INCONCLUSIVE');
  if (verdict === 'THIRD_PARTY_FAULT') reasons.push('THIRD_PARTY_FAULT always needs human review');
  if (amount > HUMAN_REVIEW_AMOUNT_USD) reasons.push(`amount ${m.order.total_value} ${m.order.currency} is above ${HUMAN_REVIEW_AMOUNT_USD}`);
  if (ai && ai.output.confidence < MIN_CONFIDENCE) reasons.push(`model confidence below ${MIN_CONFIDENCE}`);
  if (opts.appeal) reasons.push('appeal');

  return {
    evidence_pack: pack,
    evidence_pack_hash: hash,
    code_checks: checks,
    counterfactual: cf,
    decision_facts: facts,
    injection_flags: flags,
    ai_called: Boolean(ai),
    ai_output: ai?.output ?? null,
    model: ai ? { provider: ai.provider, id: ai.modelId, earlier_failures: ai.failures } : null,
    prompt_version_hash: PROMPT_VERSION_HASH,
    validation,
    final_verdict: verdict,
    requires_human_review: reasons.length > 0,
    human_review_reasons: reasons,
  };
}
