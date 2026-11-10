import { Router } from 'express';
import { findCase } from '../accountability/cases';
import { db } from '../shared/db/pool';
import { route } from '../shared/http/errors';
import { uuidParam } from '../shared/http/ids';
import { reconcileObligation } from './confirm';
import { executeObligation, settlementView } from './executor';
import { ensureObligation } from './obligations';

export const settlements = Router();

/** GET /settlements: every obligation with its actions, PayPal ids and confirmation state. */
settlements.get(
  '/',
  route(async (_req, res) => {
    const { rows } = await db().query<{ id: string }>('SELECT id FROM settlement_obligations ORDER BY created_at DESC LIMIT 50');
    res.json(await Promise.all(rows.map((r) => settlementView(r.id))));
  }),
);

settlements.get('/:id', route(async (req, res) => res.json(await settlementView(uuidParam(req.params.id, 'Obligation'), true))));

/** POST /settlements/:id/execute: checks, then the next PayPal action(s). Safe to repeat. */
settlements.post(
  '/:id/execute',
  route(async (req, res) => {
    const id = uuidParam(req.params.id, 'Obligation');
    const result = await executeObligation(id);
    res.json({ result, settlement: await settlementView(id, true) });
  }),
);

/** POST /settlements/:id/reconcile: confirm pending actions with GETs (when a webhook is late). */
settlements.post(
  '/:id/reconcile',
  route(async (req, res) => {
    const id = uuidParam(req.params.id, 'Obligation');
    const r = await reconcileObligation(id);
    res.json({ ...r, settlement: await settlementView(id, true) });
  }),
);

/** GET /cases/:id/settlement */
export const caseSettlement = Router();
caseSettlement.get(
  '/:id/settlement',
  route(async (req, res) => {
    const cs = await findCase(req.params.id);
    const rulings = (await db().query<{ id: string; status: string }>('SELECT id, status FROM rulings WHERE case_id = $1 ORDER BY created_at DESC', [cs.id])).rows;
    const obs = (await db().query<{ id: string }>('SELECT id FROM settlement_obligations WHERE case_id = $1 ORDER BY created_at', [cs.id])).rows;
    res.json({ case_id: cs.id, case_ref: cs.case_ref, case_status: cs.status, rulings, obligations: await Promise.all(obs.map((o) => settlementView(o.id, true))) });
  }),
);

export { ensureObligation };
