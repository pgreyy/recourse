import { Router } from 'express';
import { caseEvidence, caseView, findCase } from '../accountability/cases';
import { settlementView } from '../settlement/executor';
import { db } from '../shared/db/pool';
import { notFound, route } from '../shared/http/errors';
import { uuidParam } from '../shared/http/ids';
import { ClerkTurn, clerkTurn } from './clerk';
import { agentsAndOperators, caseContext, caseRows, overview, recoveredByAgentVersion, runView } from './queries';

/** Read-only endpoints for the screens and the Clerk (plus the Clerk's model turn). */
export const consoleRoutes = Router();

consoleRoutes.get('/overview', route(async (_req, res) => res.json(await overview())));
consoleRoutes.get('/cases', route(async (_req, res) => res.json(await caseRows())));

/** Everything the case screen shows: the case, its evidence and checks, mandate, timeline, settlement. */
consoleRoutes.get(
  '/cases/:id',
  route(async (req, res) => {
    const cs = await findCase(req.params.id);
    const [view, evidence, ctx] = await Promise.all([caseView(cs), caseEvidence(cs), caseContext(cs.id)]);
    const obs = (await db().query<{ id: string }>('SELECT id FROM settlement_obligations WHERE case_id = $1 ORDER BY created_at', [cs.id])).rows;
    const settlement = await Promise.all(obs.map((o) => settlementView(o.id, true)));
    const { evidence_pack, ...checks } = evidence;
    res.json({
      case: view,
      mandate: ctx.mandate,
      order: ctx.order,
      timeline: ctx.timeline,
      chain: ctx.chain,
      clauses: (evidence_pack as any)?.mandate?.clauses ?? [],
      ...checks,
      settlement,
    });
  }),
);

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

/** Mandates a buyer has approved (ACTIVE), for the agent screen. */
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
