import { agentCoverage } from '../authorization/coverage';
import { appendEntry } from '../evidence/recorder';
import { loadSigner, signDocument } from '../shared/crypto/signing';
import { db, tx } from '../shared/db/pool';
import { HttpError, notFound } from '../shared/http/errors';
import { looksLikeInstruction } from './injection';
import { codeChecks } from './checks';
import { loadCaseMaterial, type CaseRow } from './material';
import { runPipeline, type PipelineResult } from './pipeline';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A case by uuid or by case_ref (the newest case for that ref). */
export async function findCase(idOrRef: string): Promise<CaseRow> {
  const r = UUID.test(idOrRef)
    ? await db().query<CaseRow>('SELECT * FROM cases WHERE id = $1', [idOrRef])
    : await db().query<CaseRow>('SELECT * FROM cases WHERE case_ref = $1 ORDER BY created_at DESC LIMIT 1', [idOrRef]);
  if (!r.rows[0]) throw notFound('Case', idOrRef);
  return r.rows[0];
}

/** Workflow A: a buyer opens a case for one of their orders (the receipt's "Report an issue" does the same). */
export async function openBuyerCase(orderRef: string, description: string) {
  const o = (await db().query('SELECT id, case_ref, order_ref FROM orders WHERE order_ref = $1', [orderRef])).rows[0];
  if (!o) throw notFound('Order', orderRef);
  const receipt = (await db().query('SELECT id FROM receipts WHERE order_id = $1', [o.id])).rows[0];
  return tx(async (c) => {
    const { rows } = await c.query<CaseRow>(
      `INSERT INTO cases (case_ref, order_id, receipt_id, status, opened_by, source, description) VALUES ($1, $2, $3, 'OPEN', 'BUYER', 'BUYER_REPORT', $4) RETURNING *`,
      [o.case_ref, o.id, receipt?.id ?? null, description.slice(0, 2000)],
    );
    await appendEntry(o.case_ref, 'buyer.issue.reported', { case_id: rows[0].id, order_ref: o.order_ref, description: description.slice(0, 2000) }, c);
    return rows[0];
  });
}

/**
 * Workflow B: a PayPal dispute (already re-read from PayPal, not taken from the webhook body) is matched
 * to our order through custom_id (the mandate hash), invoice_id (our order ref) or the capture id, and
 * opens a case (source PAYPAL_DISPUTE). Idempotent per dispute id.
 */
export async function openCaseFromDispute(dispute: any): Promise<CaseRow | null> {
  const id = dispute.dispute_id;
  const tx0 = dispute.disputed_transactions?.[0] ?? {};
  const o = (
    await db().query(
      `SELECT id, case_ref, order_ref FROM orders
       WHERE invoice_id = $1 OR paypal_capture_id = $2 OR (custom_id = $3 AND custom_id <> '')
       ORDER BY (invoice_id = $1) DESC, created_at DESC LIMIT 1`,
      [tx0.invoice_number ?? null, tx0.seller_transaction_id ?? null, tx0.custom ?? null],
    )
  ).rows[0];
  if (!o) return null;
  const existing = (await db().query<CaseRow>('SELECT * FROM cases WHERE dispute_id = $1', [id])).rows[0];
  if (existing) return existing;
  const buyerNotes: string[] = [
    ...(dispute.evidences ?? []).filter((e: { source?: string }) => e.source === 'SUBMITTED_BY_BUYER').map((e: { notes?: string }) => e.notes ?? ''),
    ...(dispute.messages ?? []).filter((x: { posted_by?: string }) => x.posted_by === 'BUYER').map((x: { content?: string }) => x.content ?? ''),
  ].filter(Boolean);
  const snapshot = { dispute_id: id, reason: dispute.reason ?? null, status: dispute.status ?? null, stage: dispute.dispute_life_cycle_stage ?? null, amount: dispute.dispute_amount ?? null, buyer_notes: buyerNotes };
  const receipt = (await db().query('SELECT id FROM receipts WHERE order_id = $1', [o.id])).rows[0];
  return tx(async (c) => {
    const { rows } = await c.query<CaseRow>(
      `INSERT INTO cases (case_ref, order_id, receipt_id, status, opened_by, source, description, dispute_id, dispute_snapshot)
       VALUES ($1, $2, $3, 'OPEN', 'PAYPAL', 'PAYPAL_DISPUTE', $4, $5, $6) ON CONFLICT (dispute_id) WHERE dispute_id IS NOT NULL DO NOTHING RETURNING *`,
      [o.case_ref, o.id, receipt?.id ?? null, buyerNotes.join('\n').slice(0, 2000), id, JSON.stringify(snapshot)],
    );
    if (!rows[0]) return (await c.query<CaseRow>('SELECT * FROM cases WHERE dispute_id = $1', [id])).rows[0];
    await appendEntry(o.case_ref, 'paypal.dispute.case_opened', { case_id: rows[0].id, order_ref: o.order_ref, ...snapshot }, c);
    return rows[0];
  });
}

/** Operator-controlled text on a case. Stored and recorded as untrusted evidence; flagged if it reads like instructions. */
export async function addStatement(cs: CaseRow, party: 'OPERATOR' | 'BUYER' | 'MERCHANT', author: string | null, text: string) {
  const flagged = looksLikeInstruction(text);
  return tx(async (c) => {
    const { rows } = await c.query('INSERT INTO case_statements (case_id, party, author, text, flagged) VALUES ($1, $2, $3, $4, $5) RETURNING *', [cs.id, party, author, text.slice(0, 4000), flagged]);
    const kind = party === 'OPERATOR' ? 'operator.statement' : party === 'BUYER' ? 'buyer.statement' : 'merchant.statement';
    await appendEntry(cs.case_ref, kind, { case_id: cs.id, statement_id: rows[0].id, author, text: text.slice(0, 4000), flagged_instruction_like: flagged }, c);
    return rows[0];
  });
}

/** Run the pipeline on a live case and store the assessment. */
export async function assessCase(cs: CaseRow, appeal = false) {
  if (!cs.order_id) throw new HttpError(422, 'CASE_HAS_NO_ORDER', 'This case is not linked to an order.');
  const material = await loadCaseMaterial(cs);
  const r = await runPipeline(material, { appeal });
  const row = await storeAssessment({ caseId: cs.id, result: r, appeal });
  await db().query('UPDATE cases SET status = $2, updated_at = now() WHERE id = $1', [cs.id, r.requires_human_review ? 'NEEDS_HUMAN_REVIEW' : 'ASSESSED']);
  await appendEntry(cs.case_ref, 'case.assessed', {
    case_id: cs.id,
    assessment_id: row.id,
    verdict: r.final_verdict,
    requires_human_review: r.requires_human_review,
    human_review_reasons: r.human_review_reasons,
    evidence_pack_hash: r.evidence_pack_hash,
    prompt_version_hash: r.prompt_version_hash,
    model: r.model ? `${r.model.provider}/${r.model.id}` : null,
    injection_flags: r.injection_flags.length,
  });
  return { assessment_id: row.id, ...publicResult(r) };
}

export async function storeAssessment(a: { caseId?: string | null; result: PipelineResult; appeal?: boolean; scorecardRunId?: string; fixtureId?: string }) {
  const r = a.result;
  const { rows } = await db().query<{ id: string }>(
    `INSERT INTO assessments (case_id, scorecard_run_id, fixture_id, is_appeal, evidence_pack, evidence_pack_hash, code_checks, counterfactual, injection_flags,
       ai_called, ai_output, model_provider, model_id, prompt_version_hash, confidence, validation, final_verdict, requires_human_review, human_review_reasons)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19) RETURNING id`,
    [
      a.caseId ?? null, a.scorecardRunId ?? null, a.fixtureId ?? null, a.appeal ?? false,
      JSON.stringify(r.evidence_pack), r.evidence_pack_hash, JSON.stringify(r.code_checks), JSON.stringify(r.counterfactual), JSON.stringify(r.injection_flags),
      r.ai_called, r.ai_output ? JSON.stringify(r.ai_output) : null, r.model?.provider ?? null, r.model?.id ?? null, r.prompt_version_hash,
      r.ai_output?.confidence ?? null, JSON.stringify(r.validation), r.final_verdict, r.requires_human_review, JSON.stringify(r.human_review_reasons),
    ],
  );
  return rows[0];
}

/** The assessment as shown to people: no confidence score. */
export function publicResult(r: PipelineResult) {
  return {
    verdict: r.final_verdict,
    requires_human_review: r.requires_human_review,
    human_review_reasons: r.human_review_reasons,
    model_verdict: r.ai_output?.verdict ?? null,
    violated_clauses: r.ai_output?.violated_clauses ?? [],
    cited_entries: r.ai_output?.cited_entries ?? [],
    reasoning: r.ai_output?.reasoning ?? null,
    evidence_gaps: r.ai_output?.evidence_gaps ?? [],
    validation: r.validation,
    code_checks: r.code_checks,
    decision_facts: r.decision_facts,
    counterfactual: r.counterfactual,
    injection_flags: dedupeFlags(r.injection_flags),
    model: r.model,
    prompt_version_hash: r.prompt_version_hash,
    evidence_pack_hash: r.evidence_pack_hash,
  };
}

export function dedupeFlags<T extends { author: string; excerpt: string }>(flags: T[]): T[] {
  const seen = new Set<string>();
  return flags.filter((f) => {
    const k = `${f.author}|${f.excerpt}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** Evidence without the model: code checks, facts, counterfactual, injection flags, and the pack itself. */
export async function caseEvidence(cs: CaseRow) {
  const { buildEvidencePack } = await import('./evidence');
  const { counterfactual, decisionFacts } = await import('./checks');
  const m = await loadCaseMaterial(cs);
  const checks = codeChecks(m);
  const cf = counterfactual(m);
  const facts = decisionFacts(m);
  const { pack, hash, flags } = buildEvidencePack(m, checks, cf, facts);
  return { case_id: cs.id, case_ref: cs.case_ref, evidence_pack_hash: hash, code_checks: checks, decision_facts: facts, counterfactual: cf, injection_flags: dedupeFlags(flags), evidence_pack: pack };
}

export async function caseVerify(cs: CaseRow) {
  const m = await loadCaseMaterial(cs);
  const checks = codeChecks(m);
  return { case_id: cs.id, case_ref: cs.case_ref, all_passed: checks.every((c) => c.status !== 'FAIL'), checks };
}

const LIABLE: Record<string, 'OPERATOR' | 'MERCHANT' | 'BUYER' | 'THIRD_PARTY'> = {
  AGENT_FAULT: 'OPERATOR',
  MERCHANT_FAULT: 'MERCHANT',
  BUYER_REMORSE: 'BUYER',
  THIRD_PARTY_FAULT: 'THIRD_PARTY',
};

/**
 * Turn the latest validated assessment into an approved ruling (signed). Approving is the human review.
 * It moves no money: Phase 5 turns approved rulings into settlement obligations.
 */
export async function approveRuling(cs: CaseRow, approvedBy: { name: string; email: string }, assessmentId?: string) {
  const a = assessmentId
    ? (await db().query('SELECT * FROM assessments WHERE id = $1 AND case_id = $2', [assessmentId, cs.id])).rows[0]
    : (await db().query('SELECT * FROM assessments WHERE case_id = $1 ORDER BY created_at DESC LIMIT 1', [cs.id])).rows[0];
  if (!a) throw new HttpError(409, 'NOT_ASSESSED', 'Assess the case first (POST /cases/:id/assess).');
  if (a.final_verdict === 'INCONCLUSIVE') throw new HttpError(409, 'INCONCLUSIVE', 'An INCONCLUSIVE assessment cannot become a ruling. Fix the evidence or reassess.');
  if (!a.validation.passed) throw new HttpError(409, 'NOT_VALIDATED', 'The assessment did not pass validation.');
  const order = (await db().query('SELECT order_ref, total_value::text AS total, currency, agent_version_id FROM orders WHERE id = $1', [cs.order_id])).rows[0];
  const coverage = order.agent_version_id ? await agentCoverage(order.agent_version_id) : null;
  const windowHours = coverage?.covered
    ? (await db().query<{ h: number }>('SELECT appeal_window_hours AS h FROM liability_agreements WHERE id = $1', [coverage.agreement_id])).rows[0].h
    : 72;
  const approvedAt = new Date();
  const doc = {
    type: 'recourse.ruling',
    format: 1,
    case_id: cs.id,
    case_ref: cs.case_ref,
    order_ref: order.order_ref,
    assessment_id: a.id,
    verdict: a.final_verdict,
    liable_party: LIABLE[a.final_verdict],
    amount: { value: order.total, currency: order.currency.trim() },
    violated_clauses: a.ai_output?.violated_clauses ?? [],
    cited_entries: a.ai_output?.cited_entries ?? [],
    counterfactual: a.counterfactual,
    evidence_pack_hash: a.evidence_pack_hash.trim(),
    model: a.model_provider ? `${a.model_provider}/${a.model_id}` : null,
    prompt_version_hash: a.prompt_version_hash.trim(),
    liability_agreement: coverage?.covered ? { id: coverage.agreement_id, version: coverage.agreement_version } : null,
    approved_by: approvedBy,
    approved_at: approvedAt.toISOString(),
    appeal_deadline: new Date(approvedAt.getTime() + windowHours * 3600e3).toISOString(),
    settlement: 'not executed: Phase 5 turns approved rulings into settlement obligations',
    signing_key_id: loadSigner().keyId,
  };
  const s = signDocument(doc);
  return tx(async (c) => {
    const { rows } = await c.query(
      `INSERT INTO rulings (case_id, assessment_id, verdict, liable_party, amount_value, currency, document, document_hash, signature, signing_key_id,
         approved_by_name, approved_by_email, approved_at, appeal_deadline)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14) RETURNING id`,
      [cs.id, a.id, a.final_verdict, LIABLE[a.final_verdict], order.total, order.currency.trim(), JSON.stringify(doc), s.hash, s.signature, s.keyId, approvedBy.name, approvedBy.email, approvedAt, doc.appeal_deadline],
    );
    await c.query(`UPDATE cases SET status = 'RULING_APPROVED', updated_at = now() WHERE id = $1`, [cs.id]);
    await appendEntry(cs.case_ref, 'ruling.approved', { ruling_id: rows[0].id, case_id: cs.id, verdict: a.final_verdict, liable_party: doc.liable_party, document_hash: s.hash, signature: s.signature, approved_by: approvedBy }, c);
    return { ruling_id: rows[0].id, status: 'RULING_APPROVED', document: doc, document_hash: s.hash, signature: s.signature };
  });
}

export async function caseView(cs: CaseRow) {
  const statements = (await db().query('SELECT id, party, author, text, flagged, created_at FROM case_statements WHERE case_id = $1 ORDER BY created_at', [cs.id])).rows;
  const a = (await db().query('SELECT * FROM assessments WHERE case_id = $1 ORDER BY created_at DESC LIMIT 1', [cs.id])).rows[0];
  const ruling = (await db().query('SELECT id, status, verdict, liable_party, amount_value::text AS amount, currency, document_hash, approved_by_name, approved_at, appeal_deadline FROM rulings WHERE case_id = $1 ORDER BY created_at DESC LIMIT 1', [cs.id])).rows[0] ?? null;
  const order = cs.order_id ? (await db().query('SELECT order_ref, total_value::text AS total, currency, compliance, paypal_capture_id FROM orders WHERE id = $1', [cs.order_id])).rows[0] : null;
  return {
    id: cs.id,
    case_ref: cs.case_ref,
    status: cs.status,
    source: cs.source,
    opened_by: cs.opened_by,
    description: cs.description,
    dispute_id: cs.dispute_id,
    order,
    statements: statements.map((s) => ({ ...s, flag: s.flagged ? { source: 'code', note: 'instruction-like text in evidence, ignored' } : null })),
    latest_assessment: a
      ? {
          id: a.id,
          created_at: a.created_at,
          verdict: a.final_verdict,
          model_verdict: a.ai_output?.verdict ?? null,
          requires_human_review: a.requires_human_review,
          human_review_reasons: a.human_review_reasons,
          violated_clauses: a.ai_output?.violated_clauses ?? [],
          cited_entries: a.ai_output?.cited_entries ?? [],
          reasoning: a.ai_output?.reasoning ?? null,
          counterfactual: a.counterfactual,
          injection_flags: dedupeFlags(a.injection_flags),
          validation: a.validation,
          model: a.model_provider ? `${a.model_provider}/${a.model_id}` : null,
          prompt_version_hash: a.prompt_version_hash.trim(),
          evidence_pack_hash: a.evidence_pack_hash.trim(),
        }
      : null,
    ruling,
    created_at: cs.created_at,
    updated_at: cs.updated_at,
  };
}

