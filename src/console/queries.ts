import { agentVersionReputation, operatorReputation } from '../accountability/reputation';
import { receiptToken } from '../accountability/receipts';
import { agentCoverage } from '../authorization/coverage';
import { checkMandateSignature } from '../authorization/mandate-document';
import { listCheckpoints, listEntries, verifyChain, type RecorderEntry } from '../evidence/recorder';
import { getOrder } from '../paypal/orders';
import { usedUnderAgreement } from '../settlement/exposure';
import { db } from '../shared/db/pool';

/**
 * Read-only views for the screens. Nothing here moves money or changes a case; every number comes
 * from the database or from PayPal. Amounts are summed per currency, never mixed.
 */

/** Assumed PayPal dispute fee per case, used only for the labelled estimate on the overview. */
export const ASSUMED_DISPUTE_FEE = { value: '15.00', currency: 'USD' };

type Money = { value: string; currency: string };
const byCurrency = (rows: Array<{ currency: string; v: string | null }>): Money[] =>
  rows.filter((r) => r.v !== null).map((r) => ({ value: Number(r.v).toFixed(2), currency: r.currency.trim() }));

export async function overview() {
  const q = async (sql: string) => (await db().query(sql)).rows;
  const purchases = await q(
    `SELECT currency, COUNT(*)::int AS n, SUM(total_value)::text AS v FROM orders
     WHERE agent_version_id IS NOT NULL AND captured_at IS NOT NULL GROUP BY currency`,
  );
  const openCases = await q(`SELECT COUNT(*)::int AS n FROM cases WHERE status <> 'CLOSED'`);
  const recovered = await q(`SELECT currency, COUNT(*)::int AS n, SUM(recovered_value)::text AS v FROM settlement_obligations WHERE status = 'RECOVERED' GROUP BY currency`);
  const pending = await q(
    `SELECT currency, COUNT(*)::int AS n, SUM(amount_value)::text AS v FROM settlement_obligations
     WHERE status IN ('OPEN', 'BUYER_REFUNDED', 'AWAITING_CONFIRMATION', 'INVOICED', 'AWAITING_PAYPAL') GROUP BY currency`,
  );
  const agreements = (
    await db().query<{ id: string; operator: string; version: number; aggregate_cap: string; currency: string }>(
      `SELECT la.id, o.name AS operator, la.version, la.aggregate_cap::text, la.currency FROM liability_agreements la
       JOIN operators o ON o.id = la.operator_id WHERE la.status = 'ACCEPTED' ORDER BY o.name`,
    )
  ).rows;
  const exposure: Array<{ agreement_id: string; operator: string; agreement_version: number; cap: Money; used: Money; remaining: Money }> = [];
  for (const a of agreements) {
    const used = await usedUnderAgreement(a.id);
    exposure.push({
      agreement_id: a.id,
      operator: a.operator,
      agreement_version: a.version,
      cap: { value: Number(a.aggregate_cap).toFixed(2), currency: a.currency.trim() },
      used: { value: (used.usedCents / 100).toFixed(2), currency: a.currency.trim() },
      remaining: { value: ((Math.round(Number(a.aggregate_cap) * 100) - used.usedCents) / 100).toFixed(2), currency: a.currency.trim() },
    });
  }
  exposure.sort((x, y) => Number(y.used.value) - Number(x.used.value));
  // Buyer-reported cases that Recourse settled directly: the buyer had no reason to open a PayPal dispute.
  const resolvedDirect = (
    await db().query<{ n: number }>(
      `SELECT COUNT(DISTINCT c.id)::int AS n FROM cases c JOIN settlement_obligations s ON s.case_id = c.id
       WHERE c.source = 'BUYER_REPORT' AND s.status IN ('RECOVERED', 'COMPLETED', 'NO_ACTION')`,
    )
  ).rows[0].n;
  return {
    agent_purchases: { count: purchases.reduce((s, r) => s + r.n, 0), amount: byCurrency(purchases) },
    cases_open: openCases[0].n,
    recovered_confirmed: { count: recovered.reduce((s, r) => s + r.n, 0), amount: byCurrency(recovered) },
    pending_settlement: { count: pending.reduce((s, r) => s + r.n, 0), amount: byCurrency(pending) },
    exposure,
    dispute_costs_avoided_estimate: {
      is_estimate: true,
      cases_resolved_without_dispute: resolvedDirect,
      assumed_fee_per_dispute: ASSUMED_DISPUTE_FEE,
      amount: { value: (resolvedDirect * Number(ASSUMED_DISPUTE_FEE.value)).toFixed(2), currency: ASSUMED_DISPUTE_FEE.currency },
      basis: 'buyer-reported cases settled by Recourse (no PayPal dispute opened) x an assumed dispute fee; not a PayPal figure',
    },
  };
}

/** One row per case, newest first, with the agent, operator, latest ruling and settlement. */
export async function caseRows() {
  const { rows } = await db().query(
    `SELECT c.id, c.case_ref, c.status, c.source, c.dispute_id, c.created_at,
            o.order_ref, o.total_value::text AS amount, o.currency, o.paypal_order_id, o.paypal_capture_id, o.compliance,
            a.name AS agent_name, v.version AS agent_version, v.id AS agent_version_id, op.name AS operator_name,
            r.id AS ruling_id, r.status AS ruling_status, r.verdict AS ruling_verdict, r.operator_accepted_at,
            asm.final_verdict AS assessed_verdict, asm.validation->>'passed' AS validation_passed,
            s.id AS obligation_id, s.kind AS obligation_kind, s.status AS settlement_status, s.recovered_value::text AS recovered, s.currency AS settlement_currency
     FROM cases c
     LEFT JOIN orders o ON o.id = c.order_id
     LEFT JOIN agent_versions v ON v.id = o.agent_version_id
     LEFT JOIN agents a ON a.id = v.agent_id
     LEFT JOIN operators op ON op.id = a.operator_id
     LEFT JOIN LATERAL (SELECT * FROM rulings WHERE case_id = c.id ORDER BY created_at DESC LIMIT 1) r ON true
     LEFT JOIN LATERAL (SELECT final_verdict, validation FROM assessments WHERE case_id = c.id ORDER BY created_at DESC LIMIT 1) asm ON true
     LEFT JOIN LATERAL (SELECT * FROM settlement_obligations WHERE case_id = c.id ORDER BY created_at DESC LIMIT 1) s ON true
     ORDER BY c.created_at DESC LIMIT 200`,
  );
  const out = [];
  for (const r of rows) {
    const ev = await evidenceStatus(r.case_ref);
    out.push({
      id: r.id,
      case_ref: r.case_ref,
      status: r.status,
      source: r.source,
      dispute_id: r.dispute_id,
      created_at: r.created_at,
      order_ref: r.order_ref,
      amount: r.amount ? { value: r.amount, currency: r.currency.trim() } : null,
      paypal_order_id: r.paypal_order_id,
      paypal_capture_id: r.paypal_capture_id,
      agent: r.agent_name ? `${r.agent_name} v${r.agent_version}` : null,
      agent_version_id: r.agent_version_id,
      operator: r.operator_name,
      verdict: r.ruling_verdict ?? r.assessed_verdict ?? null,
      verdict_state: r.ruling_verdict ? 'RULED' : r.assessed_verdict ? 'ASSESSED' : 'NOT_ASSESSED',
      ruling_id: r.ruling_id,
      ruling_status: r.ruling_status,
      operator_accepted: Boolean(r.operator_accepted_at),
      evidence: ev,
      obligation_id: r.obligation_id,
      settlement_status: r.settlement_status,
      recovered: r.recovered && Number(r.recovered) > 0 && r.settlement_status === 'RECOVERED' ? { value: r.recovered, currency: r.settlement_currency.trim() } : null,
    });
  }
  return out;
}

/** Chain intact and the anchor recorded as matching PayPal at checkout. Local only, no PayPal call. */
async function evidenceStatus(caseRef: string) {
  const entries = await listEntries(caseRef);
  const chain = verifyChain(caseRef, entries, await listCheckpoints(caseRef));
  const anchor = [...entries].reverse().find((e) => e.kind === 'paypal.anchor.verified');
  const anchored = anchor ? Boolean((anchor.payload as { all_match?: boolean }).all_match) : null;
  return {
    chain_valid: chain.valid,
    entries: chain.entries,
    anchor_matched: anchored,
    label: !chain.valid ? 'Chain broken' : anchored === false ? 'Anchor mismatch' : anchored ? 'Intact, anchored' : 'Intact, not anchored',
  };
}

/** Confirmed recoveries summed by agent version, optionally only those confirmed in the last N days. */
export async function recoveredByAgentVersion(days: number | null) {
  const { rows } = await db().query(
    `SELECT a.name, v.version, v.id AS agent_version_id, s.currency, COUNT(*)::int AS cases, SUM(s.recovered_value)::text AS recovered,
            MAX(s.updated_at) AS last_confirmed_at
     FROM settlement_obligations s JOIN agent_versions v ON v.id = s.agent_version_id JOIN agents a ON a.id = v.agent_id
     WHERE s.status = 'RECOVERED' AND ($1::int IS NULL OR s.updated_at >= now() - make_interval(days => $1::int))
     GROUP BY a.name, v.version, v.id, s.currency ORDER BY SUM(s.recovered_value) DESC`,
    [days],
  );
  return rows.map((r) => ({
    agent_version: `${r.name} v${r.version}`,
    agent_version_id: r.agent_version_id,
    cases: r.cases,
    recovered: { value: Number(r.recovered).toFixed(2), currency: r.currency.trim() },
    last_confirmed_at: r.last_confirmed_at,
  }));
}

/** The case's signed mandate (re-checked now) and its recorder entries. */
export async function caseContext(caseId: string) {
  const c = (await db().query('SELECT case_ref, order_id FROM cases WHERE id = $1', [caseId])).rows[0];
  const o = c?.order_id ? (await db().query('SELECT * FROM orders WHERE id = $1', [c.order_id])).rows[0] : null;
  const m = o
    ? (
        await db().query(
          `SELECT m.*, b.email AS buyer_email, pt.vault_id FROM mandates m JOIN buyers b ON b.id = m.buyer_id
           LEFT JOIN payment_tokens pt ON pt.id = m.payment_token_id WHERE m.id = $1`,
          [o.mandate_id],
        )
      ).rows[0]
    : null;
  const entries = c ? await listEntries(c.case_ref) : [];
  const chain = c ? verifyChain(c.case_ref, entries, await listCheckpoints(c.case_ref)) : null;
  return {
    mandate: m
      ? {
          id: m.id,
          version: m.version,
          status: m.status,
          buyer_email: m.buyer_email,
          source_text: m.source_text,
          spec: m.spec,
          signed_at: m.signed_at,
          signing_key_id: m.signing_key_id,
          mandate_hash: m.mandate_hash?.trim() ?? null,
          ...checkMandateSignature(m),
        }
      : null,
    order: o
      ? {
          order_ref: o.order_ref,
          lines: o.lines,
          total: { value: o.total_value, currency: o.currency.trim() },
          anchor_seq: o.anchor_seq,
          anchor_description: o.anchor_description,
          paypal_order_id: o.paypal_order_id,
          paypal_capture_id: o.paypal_capture_id,
          compliance: o.compliance,
          receipt_path: await receiptPath(o.id),
        }
      : null,
    timeline: entries.map(entryView),
    chain: chain ? { valid: chain.valid, entries: chain.entries, checkpoints: chain.checkpoints } : null,
  };
}

/** A recorder entry as the screens show it: what happened, in a line, plus the raw payload. */
export function entryView(e: RecorderEntry) {
  const p = e.payload as any;
  let title = e.kind;
  let detail = '';
  let tone: 'normal' | 'warn' | 'block' | 'money' | 'ok' = 'normal';
  switch (e.kind) {
    case 'agent.run.started':
      title = `${p.agent?.name} v${p.agent?.version} started`;
      detail = `mandate v${p.mandate?.version}, budget left ${p.budget_remaining}${p.dry_run ? ', dry run' : ''}`;
      break;
    case 'agent.tool_call':
      title = `Agent called ${p.tool}`;
      detail = p.tool === 'search_catalog' ? `searched ${Object.entries(p.input ?? {}).map(([k, v]) => `${k} ${Array.isArray(v) ? v.join(', ') : v}`).join('; ') || 'everything'}` : p.tool === 'checkout' ? `checkout ${p.input?.cart_id ?? ''}` : (p.input?.items ?? []).map((i: any) => `${i.quantity} x ${i.variant_id}`).join(', ');
      break;
    case 'merchant.cart.created':
    case 'merchant.cart.updated':
    case 'merchant.cart.viewed':
      title = `Cart ${e.kind.split('.').pop()}`;
      detail = `${(p.lines ?? []).map((l: any) => `${l.variant_id} ${l.price}`).join(', ')}; ${p.status}`;
      break;
    case 'checkout.firewall': {
      const checks = (p.checks ?? []) as Array<{ rule: string; status: string; detail: string }>;
      const warns = checks.filter((c) => c.status === 'WARN' || c.status === 'UNVERIFIABLE');
      const blocks = checks.filter((c) => c.status === 'BLOCK' || c.status === 'FAIL');
      title = blocks.length ? 'Firewall blocked checkout' : warns.length ? 'Firewall warning' : 'Firewall passed';
      detail = (blocks.length ? blocks : warns.length ? warns : []).map((c) => `${c.rule}: ${c.detail}`).join('; ') || `${checks.length} checks passed`;
      tone = blocks.length ? 'block' : warns.length ? 'warn' : 'ok';
      break;
    }
    case 'checkout.started':
      title = p.proceeded_despite_warnings ? 'Checkout proceeded despite the warning' : 'Checkout started';
      detail = p.proceeded_despite_warnings ? `warning at step ${p.proceeded_despite_warnings.warning_entry_seq} was not resolved` : `${(p.lines ?? []).map((l: any) => l.variant_id).join(', ')}`;
      tone = p.proceeded_despite_warnings ? 'warn' : 'normal';
      break;
    case 'checkout.step_up_required':
      title = 'Buyer approval required';
      tone = 'block';
      break;
    case 'paypal.order.created':
      title = 'PayPal order created';
      detail = `order ${p.paypal_order_id}, ${p.status}`;
      tone = 'money';
      break;
    case 'paypal.anchor.verified':
      title = p.all_match ? 'Anchor matched in PayPal order' : 'Anchor mismatch';
      detail = 'custom_id, invoice_id and description re-read from PayPal';
      tone = p.all_match ? 'ok' : 'block';
      break;
    case 'paypal.tracker.added':
      title = 'Tracking added';
      detail = p.tracking_number ?? '';
      break;
    case 'checkout.completed':
      title = 'Purchase captured';
      detail = `${p.amount?.value} ${p.amount?.currency_code}, ${p.order_ref}`;
      tone = 'money';
      break;
    case 'agent.run.finished':
      title = `Run finished: ${p.outcome}`;
      detail = `${p.tool_calls} tool calls, ${p.model}`;
      break;
    case 'agent.run.failed':
      title = 'Run failed';
      detail = p.error ?? '';
      tone = 'block';
      break;
    case 'buyer.issue.reported':
      title = 'Buyer reported an issue';
      detail = p.description ?? '';
      break;
    case 'operator.statement':
      title = 'Operator statement';
      detail = p.flagged_instruction_like ? 'contains instruction-like text (flagged by code)' : '';
      break;
    case 'paypal.dispute.case_opened':
      title = 'PayPal dispute opened a case';
      detail = `${p.dispute_id}: ${p.reason ?? ''}`;
      break;
    case 'case.assessed':
      title = `Assessed: ${p.verdict}`;
      break;
    case 'ruling.approved':
      title = `Ruling approved: ${p.verdict}`;
      detail = `by ${p.approved_by?.name ?? ''}`;
      break;
    case 'ruling.operator_accepted':
      title = 'Operator accepted the ruling';
      detail = 'appeal waived';
      break;
    case 'settlement.obligation_created':
      title = 'Settlement obligation created';
      detail = `${p.kind} ${p.amount?.value} ${p.amount?.currency}`;
      break;
    case 'settlement.action_intended':
      title = `Intent stored: ${p.action}`;
      detail = p.amount ? `${p.amount.value} ${p.amount.currency}` : '';
      break;
    case 'settlement.action_result':
      title = `${p.action}: ${p.status}`;
      detail = Object.entries(p.paypal_ids ?? {}).map(([k, v]) => `${k} ${v}`).join(', ');
      tone = 'money';
      break;
    case 'settlement.recovered':
      title = 'Recovered (confirmed by PayPal)';
      detail = `${p.recovered}, confirmed by ${p.confirmed_by}`;
      tone = 'ok';
      break;
    default:
      if (e.kind.startsWith('paypal.')) tone = 'money';
  }
  return { seq: e.seq, kind: e.kind, recorded_at: e.created_at, title, detail, tone, payload: e.payload, hash: e.hash };
}

/** Every agent version with coverage, reputation and merchant policy; every operator with accountability. */
export async function agentsAndOperators() {
  const versions = (
    await db().query<{ id: string }>(
      `SELECT v.id FROM agent_versions v JOIN agents a ON a.id = v.agent_id WHERE v.instructions IS NOT NULL ORDER BY a.name, v.version`,
    )
  ).rows;
  const agents = [];
  for (const v of versions) {
    const rep = await agentVersionReputation(v.id);
    const cov = await agentCoverage(v.id);
    agents.push({ ...rep, coverage: cov.covered ? { covered: true, agreement_version: cov.agreement_version } : { covered: false, reason: cov.reason } });
  }
  const ops = (await db().query<{ id: string }>(`SELECT id FROM operators ORDER BY name`)).rows;
  const operators = [];
  for (const o of ops) {
    const rep = await operatorReputation(o.id);
    const agreement = (
      await db().query(
        `SELECT version, per_incident_cap::text, aggregate_cap::text, currency, appeal_window_hours FROM liability_agreements WHERE operator_id = $1 AND status = 'ACCEPTED'`,
        [o.id],
      )
    ).rows[0];
    operators.push({ ...rep, agreement: agreement ? { ...agreement, currency: agreement.currency.trim() } : null });
  }
  return { agents, operators };
}

/** An agent run, its recorder entries, and a live check that the decision trail is anchored in the PayPal order. */
export async function runView(runId: string) {
  const run = (
    await db().query(
      `SELECT r.*, a.name AS agent_name, v.version FROM agent_runs r JOIN agent_versions v ON v.id = r.agent_version_id
       JOIN agents a ON a.id = v.agent_id WHERE r.id = $1`,
      [runId],
    )
  ).rows[0];
  if (!run) return null;
  const entries = await listEntries(run.case_ref);
  const order = (await db().query('SELECT * FROM orders WHERE case_ref = $1 ORDER BY created_at DESC LIMIT 1', [run.case_ref])).rows[0] ?? null;
  // Only the entries of this run (a later case on the same ref keeps appending after the run).
  const finished = entries.find((e) => e.kind === 'agent.run.finished' || e.kind === 'agent.run.failed');
  const runEntries = finished ? entries.filter((e) => e.seq <= finished.seq) : entries;
  return {
    run: {
      id: run.id,
      case_ref: run.case_ref,
      status: run.status,
      agent: `${run.agent_name} v${run.version}`,
      agent_version_id: run.agent_version_id,
      mandate_id: run.mandate_id,
      model: run.model_id ? `${run.model_provider}/${run.model_id}` : null,
      dry_run: run.dry_run,
      started_at: run.started_at,
      finished_at: run.finished_at,
      error: run.error,
    },
    timeline: runEntries.map(entryView),
    order: order
      ? {
          order_ref: order.order_ref,
          status: order.status,
          total: { value: order.total_value, currency: order.currency.trim() },
          paypal_order_id: order.paypal_order_id,
          paypal_capture_id: order.paypal_capture_id,
          compliance: order.compliance,
          receipt_path: await receiptPath(order.id),
        }
      : null,
    anchor: run.finished_at && order?.paypal_order_id ? await anchorCheck(order, entries) : null,
  };
}

/**
 * Re-read the PayPal order now and check that it carries this decision trail: the description holds
 * the recorder head hash at the anchor step, custom_id is the mandate hash, invoice_id the order ref,
 * and the chain still verifies up to that step.
 */
async function anchorCheck(order: any, entries: RecorderEntry[]) {
  const r = await getOrder(order.paypal_order_id);
  if (r.status !== 200) return { ok: false, checks: [{ id: 'paypal.read', ok: false, detail: `HTTP ${r.status}` }] };
  const unit = r.body.purchase_units?.[0] ?? {};
  const atAnchor = entries.find((e) => e.seq === order.anchor_seq);
  const upTo = entries.filter((e) => e.seq <= order.anchor_seq);
  const chain = verifyChain(order.case_ref, upTo, []);
  const checks = [
    { id: 'description', ok: unit.description === order.anchor_description, detail: `PayPal description: ${unit.description ?? '(none)'}` },
    { id: 'head_hash', ok: Boolean(atAnchor && order.anchor_head_hash.trim() === atAnchor.hash && String(unit.description ?? '').includes(atAnchor.hash.slice(0, 16))), detail: `recorder head at step ${order.anchor_seq}: ${atAnchor?.hash.slice(0, 16) ?? '?'}...` },
    { id: 'custom_id', ok: unit.custom_id === order.custom_id, detail: `custom_id ${String(unit.custom_id ?? '').slice(0, 16)}... is the mandate hash` },
    { id: 'invoice_id', ok: unit.invoice_id === order.invoice_id, detail: `invoice_id ${unit.invoice_id ?? '(none)'}` },
    { id: 'chain', ok: chain.valid, detail: `${chain.entries} entries up to the anchor verify` },
  ];
  return { ok: checks.every((c) => c.ok), paypal_debug_id: r.debugId ?? null, checks };
}

async function receiptPath(orderId: string): Promise<string | null> {
  const r = (await db().query<{ id: string }>('SELECT id FROM receipts WHERE order_id = $1', [orderId])).rows[0];
  return r ? `/r/${receiptToken(r.id)}` : null;
}
