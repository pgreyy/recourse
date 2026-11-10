import { Router } from 'express';
import { z } from 'zod';
import { appendEntry } from '../evidence/recorder';
import { executeObligation } from '../settlement/executor';
import { ensureObligation } from '../settlement/obligations';
import { db, tx } from '../shared/db/pool';
import { HttpError, notFound, route } from '../shared/http/errors';
import { uuidParam } from '../shared/http/ids';
import { looksLikeInstruction } from './injection';
import { agentVersionReputation, operatorReputation, recordReputationEvent } from './reputation';

export const rulings = Router();
export const appeals = Router();
export const reputation = Router();

async function loadRuling(id: string) {
  const r = (await db().query('SELECT ru.*, c.case_ref FROM rulings ru JOIN cases c ON c.id = ru.case_id WHERE ru.id = $1', [id])).rows[0];
  if (!r) throw notFound('Ruling', id);
  return r;
}

rulings.get(
  '/:id',
  route(async (req, res) => {
    const r = await loadRuling(uuidParam(req.params.id, 'Ruling'));
    const appeal = (await db().query('SELECT * FROM appeals WHERE ruling_id = $1', [r.id])).rows[0] ?? null;
    res.json({ ...r, appeal });
  }),
);

/** POST /rulings/:id/operator-accept { accepted_by }: the operator accepts the ruling and waives the appeal. */
rulings.post(
  '/:id/operator-accept',
  route(async (req, res) => {
    const body = z.object({ accepted_by: z.string().trim().min(1).max(200) }).parse(req.body);
    const r = await loadRuling(uuidParam(req.params.id, 'Ruling'));
    if (r.status !== 'RULING_APPROVED') throw new HttpError(409, 'RULING_NOT_OPEN', `Ruling is ${r.status}.`);
    if (!r.operator_accepted_at) {
      await db().query('UPDATE rulings SET operator_accepted_at = now(), operator_accepted_by = $2 WHERE id = $1', [r.id, body.accepted_by]);
      await appendEntry(r.case_ref, 'ruling.operator_accepted', { ruling_id: r.id, accepted_by: body.accepted_by, appeal_waived: true });
    }
    const ob = await ensureObligation(r.id);
    res.json({ ruling_id: r.id, operator_accepted: true, appeal_waived: true, obligation_id: ob.id, next: `POST /settlements/${ob.id}/execute` });
  }),
);

/** POST /rulings/:id/appeal { note }: operator appeal within the window. Requires human review. */
rulings.post(
  '/:id/appeal',
  route(async (req, res) => {
    const body = z.object({ note: z.string().trim().min(1).max(4000) }).parse(req.body);
    const r = await loadRuling(uuidParam(req.params.id, 'Ruling'));
    if (r.status !== 'RULING_APPROVED' && r.status !== 'SETTLED') throw new HttpError(409, 'NOT_APPEALABLE', `Ruling is ${r.status}.`);
    if (r.operator_accepted_at) throw new HttpError(409, 'APPEAL_WAIVED', 'The operator accepted this ruling and waived the appeal.');
    if (!r.appeal_deadline || new Date(r.appeal_deadline) <= new Date()) throw new HttpError(409, 'APPEAL_WINDOW_CLOSED', `The appeal window closed at ${r.appeal_deadline?.toISOString?.() ?? r.appeal_deadline}.`);
    const flagged = looksLikeInstruction(body.note);
    const operatorId = (await db().query('SELECT operator_id FROM settlement_obligations WHERE ruling_id = $1 LIMIT 1', [r.id])).rows[0]?.operator_id ?? null;
    const appeal = await tx(async (c) => {
      const a = (await c.query('INSERT INTO appeals (ruling_id, operator_id, note, flagged) VALUES ($1, $2, $3, $4) RETURNING *', [r.id, operatorId, body.note, flagged])).rows[0];
      await c.query(`UPDATE rulings SET status = 'APPEALED' WHERE id = $1`, [r.id]);
      await c.query(`UPDATE cases SET status = 'APPEALED', updated_at = now() WHERE id = $1`, [r.case_id]);
      await appendEntry(r.case_ref, 'ruling.appealed', { ruling_id: r.id, appeal_id: a.id, note: body.note, flagged_instruction_like: flagged }, c);
      return a;
    });
    res.status(201).json({
      ...appeal,
      requires_human_review: true,
      flag: flagged ? { source: 'code', note: 'instruction-like text in evidence, ignored' } : null,
      note_on_settlement: 'operator recovery is on hold while the appeal is open; the buyer refund is not affected',
    });
  }),
);

/** POST /appeals/:id/decide { decision: UPHOLD | REVERSE, decided_by, note }: a human decides. */
appeals.post(
  '/:id/decide',
  route(async (req, res) => {
    const body = z.object({ decision: z.enum(['UPHOLD', 'REVERSE']), decided_by: z.string().trim().min(1), note: z.string().trim().max(2000).default('') }).parse(req.body);
    const a = (await db().query('SELECT * FROM appeals WHERE id = $1', [uuidParam(req.params.id, 'Appeal')])).rows[0];
    if (!a) throw notFound('Appeal', req.params.id);
    if (a.status !== 'OPEN') throw new HttpError(409, 'APPEAL_DECIDED', `Appeal is ${a.status}.`);
    const r = await loadRuling(a.ruling_id);
    let reversal: string | null = null;
    await tx(async (c) => {
      await c.query('UPDATE appeals SET status = $2, decided_by = $3, decision_note = $4, decided_at = now() WHERE id = $1', [a.id, body.decision === 'UPHOLD' ? 'UPHELD' : 'REVERSED', body.decided_by, body.note]);
      if (body.decision === 'UPHOLD') {
        const recovered = (await c.query(`SELECT status FROM settlement_obligations WHERE ruling_id = $1 AND kind = 'RECOVERY'`, [r.id])).rows[0]?.status === 'RECOVERED';
        await c.query('UPDATE rulings SET status = $2 WHERE id = $1', [r.id, recovered ? 'SETTLED' : 'RULING_APPROVED']);
        await c.query(`UPDATE cases SET status = 'RULING_APPROVED', updated_at = now() WHERE id = $1`, [r.case_id]);
      } else {
        await c.query(`UPDATE rulings SET status = 'REVERSED' WHERE id = $1`, [r.id]);
        await c.query(`UPDATE cases SET status = 'CLOSED', updated_at = now() WHERE id = $1`, [r.case_id]);
        // Compensating reputation events for anything already counted.
        const counted = (await c.query(`SELECT * FROM reputation_events WHERE ruling_id = $1 AND kind IN ('CONFIRMED_AGENT_FAULT', 'OBLIGATION_PAID')`, [r.id])).rows;
        for (const e of counted) {
          await recordReputationEvent(c, {
            kind: e.kind === 'CONFIRMED_AGENT_FAULT' ? 'AGENT_FAULT_REVERSED' : 'OBLIGATION_REVERSED',
            agentVersionId: e.agent_version_id, operatorId: e.operator_id, rulingId: r.id, obligationId: e.obligation_id, amount: e.amount_value, currency: e.currency, weight: -Number(e.weight),
          });
        }
        // Money already moved from the operator: a reversal obligation refunds it.
        const charged = (await c.query(
          `SELECT o.* FROM settlement_obligations o JOIN settlement_actions s ON s.obligation_id = o.id
           WHERE o.ruling_id = $1 AND o.kind = 'RECOVERY' AND s.action = 'CHARGE_OPERATOR' AND s.status = 'SUCCEEDED'`, [r.id])).rows[0];
        if (charged) {
          reversal = (await c.query(
            `INSERT INTO settlement_obligations (ruling_id, case_id, kind, workflow, verdict, status, amount_value, currency, operator_id, liability_agreement_id, agent_version_id)
             VALUES ($1, $2, 'REVERSAL', 'A', $3, 'OPEN', $4, $5, $6, $7, $8) ON CONFLICT (ruling_id, kind) DO NOTHING RETURNING id`,
            [r.id, r.case_id, r.verdict, charged.recovered_value, charged.currency, charged.operator_id, charged.liability_agreement_id, charged.agent_version_id])).rows[0]?.id ?? null;
        }
      }
      await appendEntry(r.case_ref, 'appeal.decided', { appeal_id: a.id, ruling_id: r.id, decision: body.decision, decided_by: body.decided_by, note: body.note, reversal_obligation_id: reversal }, c);
    });
    const executed = reversal ? await executeObligation(reversal) : null;
    res.json({ appeal_id: a.id, decision: body.decision, ruling_status: body.decision === 'UPHOLD' ? 'upheld' : 'REVERSED', reversal_obligation_id: reversal, reversal_result: executed });
  }),
);

/** GET /agents/:id/reputation: :id is an agent id (all its versions) or an agent version id. */
reputation.get(
  '/agents/:id/reputation',
  route(async (req, res) => {
    const id = uuidParam(req.params.id, 'Agent');
    const asVersion = await agentVersionReputation(id);
    if (asVersion) return res.json(asVersion);
    const versions = (await db().query<{ id: string }>('SELECT id FROM agent_versions WHERE agent_id = $1 ORDER BY created_at', [id])).rows;
    if (!versions.length) throw notFound('Agent', id);
    res.json({ agent_id: id, versions: await Promise.all(versions.map((v) => agentVersionReputation(v.id))) });
  }),
);

reputation.get(
  '/operators/:id/reputation',
  route(async (req, res) => {
    const r = await operatorReputation(uuidParam(req.params.id, 'Operator'));
    if (!r) throw notFound('Operator', req.params.id);
    res.json(r);
  }),
);
