import { Router } from 'express';
import { z } from 'zod';
import { db } from '../shared/db/pool';
import { route } from '../shared/http/errors';
import { addStatement, approveRuling, assessCase, caseEvidence, caseVerify, caseView, findCase, openBuyerCase } from './cases';

export const cases = Router();

/** POST /cases { order_ref, description }: workflow A (same as "Report an issue" on the receipt). */
cases.post(
  '/',
  route(async (req, res) => {
    const body = z.object({ order_ref: z.string().min(1), description: z.string().trim().min(1).max(2000) }).parse(req.body);
    res.status(201).json(await caseView(await openBuyerCase(body.order_ref, body.description)));
  }),
);

cases.get(
  '/',
  route(async (req, res) => {
    const status = typeof req.query.status === 'string' ? req.query.status : null;
    const { rows } = await db().query(
      `SELECT c.id, c.case_ref, c.status, c.source, c.opened_by, c.dispute_id, c.created_at, o.order_ref
       FROM cases c LEFT JOIN orders o ON o.id = c.order_id WHERE ($1::text IS NULL OR c.status = $1) ORDER BY c.created_at DESC LIMIT 100`,
      [status],
    );
    res.json(rows);
  }),
);

/** :id is a case uuid or a case_ref (the newest case for that ref). */
cases.get('/:id', route(async (req, res) => res.json(await caseView(await findCase(req.params.id)))));
cases.get('/:id/evidence', route(async (req, res) => res.json(await caseEvidence(await findCase(req.params.id)))));
cases.get('/:id/verify', route(async (req, res) => res.json(await caseVerify(await findCase(req.params.id)))));

/** POST /cases/:id/assess { appeal? }: code checks, counterfactual, injection scan, then the model, then validation. */
cases.post(
  '/:id/assess',
  route(async (req, res) => {
    const body = z.object({ appeal: z.boolean().optional() }).parse(req.body ?? {});
    res.json(await assessCase(await findCase(req.params.id), Boolean(body.appeal)));
  }),
);

/** POST /cases/:id/operator-statement { text, author? }: operator-controlled text, kept as untrusted evidence. */
cases.post(
  '/:id/operator-statement',
  route(async (req, res) => {
    const body = z.object({ text: z.string().trim().min(1).max(4000), author: z.string().trim().max(200).optional() }).parse(req.body);
    const cs = await findCase(req.params.id);
    const st = await addStatement(cs, 'OPERATOR', body.author ?? null, body.text);
    res.status(201).json({ ...st, flag: st.flagged ? { source: 'code', note: 'instruction-like text in evidence, ignored' } : null });
  }),
);

/** POST /cases/:id/approve { approved_by: { name, email }, assessment_id? }: approved ruling, no money moves. */
cases.post(
  '/:id/approve',
  route(async (req, res) => {
    const body = z
      .object({ approved_by: z.object({ name: z.string().trim().min(1), email: z.string().trim().email() }), assessment_id: z.string().uuid().optional() })
      .parse(req.body);
    res.json(await approveRuling(await findCase(req.params.id), body.approved_by, body.assessment_id));
  }),
);
