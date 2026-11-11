import { homeData } from './home';
import { Router } from 'express';
import { caseEvidence, caseView, findCase } from '../accountability/cases';
import type { CaseRow } from '../accountability/material';
import { settlementView } from '../settlement/executor';
import { db } from '../shared/db/pool';
import { notFound, route } from '../shared/http/errors';
import { uuidParam } from '../shared/http/ids';
import { ClerkTurn, clerkTurn } from './clerk';
import { env } from '../config';
import { aiBudget } from '../shared/ai/budget';
import { agentsAndOperators, caseContext, caseRows, overview, recoveredByAgentVersion, runView } from './queries';
import { plainText } from './plain';
import { instructionWords } from '../shared/words';

/** Read-only endpoints for the screens and the Clerk (plus the Clerk's model turn). */
export const consoleRoutes = Router();

consoleRoutes.get('/overview', route(async (_req, res) => res.json(await overview())));
/** The home page: live figures and the story card from the latest confirmed recovery (public, read-only). */
consoleRoutes.get('/home', route(async (_req, res) => res.json(await homeData())));
consoleRoutes.get('/cases', route(async (_req, res) => res.json(await caseRows())));

/**
 * Everything the case screen shows: the case, its evidence and checks, instructions, timeline, settlement.
 * The PayPal part (order, capture, dispute) is read live once and cached with its time; the cache is
 * reused until "Re-verify now" (POST /console/cases/:id/verify) or until the case's recorder has new
 * entries, so the screen opens at database speed.
 */
async function caseDetail(cs: CaseRow, force: boolean) {
  const [h, cq, oq] = await Promise.all([
    db().query<{ s: number | null }>('SELECT MAX(seq) AS s FROM recorder_entries WHERE case_ref = $1', [cs.case_ref]),
    db().query('SELECT verified_at, head_seq, evidence, disputes FROM case_verifications WHERE case_id = $1', [cs.id]),
    db().query<{ id: string; workflow: string }>('SELECT id, workflow FROM settlement_obligations WHERE case_id = $1 ORDER BY created_at', [cs.id]),
  ]);
  const head = h.rows[0].s ?? 0;
  const cached = cq.rows[0];
  const obs = oq.rows;
  let verification: { evidence: any; disputes: Record<string, unknown>; verified_at: Date; cached: boolean };
  if (!force && cached && cached.head_seq === head) {
    verification = { evidence: cached.evidence, disputes: cached.disputes, verified_at: cached.verified_at, cached: true };
  } else {
    const { evidence_pack, ...checks } = await caseEvidence(cs);
    // Wording for people: code-written texts say "instructions" and "decision" (identifiers keep their names).
    const words = (x: any) => (x && typeof x === 'object' ? Object.fromEntries(Object.entries(x).map(([k, v]) => [k, typeof v === 'string' && /^(detail|label|text|fact|note|summary|title)$/.test(k) ? instructionWords(v) : v])) : x);
    const evidence = {
      ...checks,
      code_checks: (checks as any).code_checks?.map(words) ?? (checks as any).code_checks,
      decision_facts: (checks as any).decision_facts?.map(words) ?? (checks as any).decision_facts,
      counterfactual: words((checks as any).counterfactual),
      clauses: ((evidence_pack as any)?.mandate?.clauses ?? []).map((c: { text: string }) => ({ ...c, text: plainText(c.text) })),
    };
    const disputes: Record<string, unknown> = {};
    for (const o of obs.filter((x) => x.workflow === 'B')) disputes[o.id] = (await settlementView(o.id, true)).paypal_dispute;
    const at = new Date();
    await db().query(
      `INSERT INTO case_verifications (case_id, verified_at, head_seq, evidence, disputes) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (case_id) DO UPDATE SET verified_at = EXCLUDED.verified_at, head_seq = EXCLUDED.head_seq, evidence = EXCLUDED.evidence, disputes = EXCLUDED.disputes`,
      [cs.id, at, head, JSON.stringify(evidence), JSON.stringify(disputes)],
    );
    verification = { evidence, disputes, verified_at: at, cached: false };
  }
  // Settlement state from the database (fast); the live dispute status from the last PayPal read.
  const [view, ctx, settlement] = await Promise.all([
    caseView(cs),
    caseContext(cs.id),
    Promise.all(obs.map(async (o) => ({ ...(await settlementView(o.id, false)), paypal_dispute: verification.disputes[o.id] ?? null }))),
  ]);
  return {
    case: view,
    mandate: ctx.mandate,
    order: ctx.order,
    timeline: ctx.timeline,
    chain: ctx.chain,
    ...verification.evidence,
    settlement,
    verification: { verified_at: verification.verified_at, from_cache: verification.cached, covers_recorder_up_to: head },
  };
}

consoleRoutes.get('/cases/:id', route(async (req, res) => res.json(await caseDetail(await findCase(req.params.id), req.query.reverify === '1'))));

/** Re-verify now: read PayPal live and refresh the cache. */
/**
 * GET /console/cases/:id/operator-view: what the operator needs to accept or appeal a decision: the operator, its
 * accepted agreement with the cap used and left, the appeal deadline and any appeal, and a preview of the money.
 */
consoleRoutes.get(
  '/cases/:id/operator-view',
  route(async (req, res) => {
    const cs = await findCase(req.params.id);
    const ctx = (
      await db().query(
        `SELECT o.id AS operator_id, o.name AS operator_name, ord.total_value::text AS total, ord.currency
           FROM orders ord JOIN agent_versions v ON v.id = ord.agent_version_id JOIN agents ag ON ag.id = v.agent_id JOIN operators o ON o.id = ag.operator_id
          WHERE ord.id = $1`,
        [cs.order_id],
      )
    ).rows[0];
    if (!ctx) return res.json({ operator: null });
    const la = (
      await db().query(
        `SELECT id, version, per_incident_cap::text, aggregate_cap::text, currency, appeal_window_hours FROM liability_agreements WHERE operator_id = $1 AND status = 'ACCEPTED'`,
        [ctx.operator_id],
      )
    ).rows[0];
    const used = la ? (await db().query(`SELECT COALESCE(SUM(recovered_value), 0)::text AS v FROM settlement_obligations WHERE liability_agreement_id = $1 AND status = 'RECOVERED'`, [la.id])).rows[0].v : '0';
    const ruling = (await db().query('SELECT id FROM rulings WHERE case_id = $1 ORDER BY created_at DESC LIMIT 1', [cs.id])).rows[0];
    const appeal = ruling ? (await db().query('SELECT id, status, note, flagged, created_at, decided_by, decision_note FROM appeals WHERE ruling_id = $1 ORDER BY created_at DESC LIMIT 1', [ruling.id])).rows[0] ?? null : null;
    const total = Number(ctx.total);
    const perIncident = la ? Number(la.per_incident_cap) : 0;
    res.json({
      operator: { id: ctx.operator_id, name: ctx.operator_name },
      agreement: la
        ? { version: la.version, per_incident_cap: la.per_incident_cap, aggregate_cap: la.aggregate_cap, currency: la.currency.trim(), appeal_window_hours: la.appeal_window_hours, used: Number(used).toFixed(2), cap_remaining: (Number(la.aggregate_cap) - Number(used)).toFixed(2) }
        : null,
      appeal,
      // Before settlement: the buyer is refunded the total; the operator is charged that plus PayPal's fee on the charge
      // (the merchant ends as after an undisputed sale), never more than the per-incident cap or what is left of the total cap.
      preview: {
        buyer_refund: total.toFixed(2),
        operator_charge_from: total.toFixed(2),
        operator_charge_limit: la ? Math.min(perIncident, Number(la.aggregate_cap) - Number(used)).toFixed(2) : null,
        currency: ctx.currency.trim(),
      },
    });
  }),
);

consoleRoutes.post('/cases/:id/verify', route(async (req, res) => res.json(await caseDetail(await findCase(req.params.id), true))));

consoleRoutes.get(
  '/recovered-by-agent-version',
  route(async (req, res) => {
    const days = typeof req.query.days === 'string' && /^\d{1,4}$/.test(req.query.days) ? Number(req.query.days) : null;
    res.json({ days, confirmed_only: true, rows: await recoveredByAgentVersion(days) });
  }),
);

consoleRoutes.get('/agents', route(async (_req, res) => res.json(await agentsAndOperators())));

consoleRoutes.get(
  '/runs/:id',
  route(async (req, res) => {
    const v = await runView(uuidParam(req.params.id, 'Agent run'));
    if (!v) throw notFound('Agent run', req.params.id);
    res.json(v);
  }),
);

/** Recent agent runs, for picking one to replay on the agent screen. */
consoleRoutes.get(
  '/runs',
  route(async (_req, res) => {
    const { rows } = await db().query(
      `SELECT r.id, r.case_ref, r.status, r.dry_run, r.started_at, a.name AS agent_name, v.version
       FROM agent_runs r JOIN agent_versions v ON v.id = r.agent_version_id JOIN agents a ON a.id = v.agent_id
       ORDER BY r.started_at DESC LIMIT 30`,
    );
    res.json(rows.map((r) => ({ id: r.id, case_ref: r.case_ref, status: r.status, dry_run: r.dry_run, started_at: r.started_at, agent: `${r.agent_name} v${r.version}` })));
  }),
);

/** Signed instructions a buyer has approved (ACTIVE), for the agent screen. */
consoleRoutes.get(
  '/mandates',
  route(async (_req, res) => {
    const { rows } = await db().query(
      `SELECT m.id, m.version, m.status, m.source_text, m.expires_at, b.email AS buyer_email, m.created_at FROM mandates m
       JOIN buyers b ON b.id = m.buyer_id WHERE m.status IN ('ACTIVE', 'DRAFT') ORDER BY m.created_at DESC LIMIT 30`,
    );
    res.json(rows);
  }),
);

consoleRoutes.get(
  '/operators',
  route(async (_req, res) => {
    const { rows } = await db().query(
      `SELECT o.id, o.name, o.email, o.status, (SELECT COUNT(*)::int FROM agents a WHERE a.operator_id = o.id) AS agents FROM operators o ORDER BY o.created_at`,
    );
    res.json(rows);
  }),
);

consoleRoutes.post(
  '/clerk/turn',
  route(async (req, res) => {
    res.json(await clerkTurn(ClerkTurn.parse(req.body)));
  }),
);

/**
 * The judges page: sandbox logins come from the environment at request time (never from the repo),
 * plus the demo limits. JUDGE_* override the BUYER_EMAIL / OPERATOR_EMAIL used by the probes.
 */
consoleRoutes.get(
  '/judges',
  route(async (_req, res) => {
    const login = (email?: string, password?: string) => (email ? { email, password: password ?? null } : null);
    res.json({
      buyer: login(env('JUDGE_BUYER_EMAIL') ?? env('BUYER_EMAIL'), env('JUDGE_BUYER_PASSWORD')),
      operator: login(env('JUDGE_OPERATOR_EMAIL') ?? env('OPERATOR_EMAIL'), env('JUDGE_OPERATOR_PASSWORD')),
      limits: { ai_calls: aiBudget(), agent_runs_per_ip_per_hour: Number(env('AGENT_RUNS_PER_IP_PER_HOUR', '3')) },
    });
  }),
);
