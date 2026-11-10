import type pg from 'pg';
import { db } from '../shared/db/pool';

/**
 * Reputation comes only from finalized rulings: an AGENT_FAULT counts once its obligation is RECOVERED
 * (or once an appeal is decided). Pending cases are listed separately and never count.
 *
 *   agent reliability (per agent version) = 1 - confirmed agent-fault amount / amount the agent bought
 *   operator accountability (per operator) = obligations paid / (paid + failed); plus outstanding exposure
 *
 * Merchant policy per agent version: suspended with 3+ confirmed agent faults in 30 days, step-up with
 * 1+, otherwise normal. Step-up means every checkout needs the buyer's fresh approval.
 */
export const STEP_UP_REASON = 'recent confirmed agent fault';
export const SUSPENDED_REASON = 'agent suspended after repeated confirmed agent faults';
const WINDOW_DAYS = 30;
const SUSPEND_AT = 3;

type Kind = 'CONFIRMED_AGENT_FAULT' | 'AGENT_FAULT_REVERSED' | 'OBLIGATION_PAID' | 'OBLIGATION_FAILED' | 'OBLIGATION_REVERSED';

export async function recordReputationEvent(
  c: pg.PoolClient | pg.Pool,
  e: { kind: Kind; agentVersionId?: string | null; operatorId?: string | null; rulingId: string; obligationId?: string | null; amount: string; currency: string; weight: number },
) {
  await c.query(
    `INSERT INTO reputation_events (kind, agent_version_id, operator_id, ruling_id, obligation_id, amount_value, currency, weight)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT (kind, ruling_id, obligation_id) DO NOTHING`,
    [e.kind, e.agentVersionId ?? null, e.operatorId ?? null, e.rulingId, e.obligationId ?? null, e.amount, e.currency, e.weight],
  );
}

export async function merchantPolicy(agentVersionId: string, c: pg.Pool | pg.PoolClient = db()) {
  const { rows } = await c.query<{ net: string; last: Date | null }>(
    `SELECT COALESCE(SUM(CASE kind WHEN 'CONFIRMED_AGENT_FAULT' THEN 1 WHEN 'AGENT_FAULT_REVERSED' THEN -1 ELSE 0 END), 0) AS net, MAX(occurred_at) AS last
     FROM reputation_events WHERE agent_version_id = $1 AND kind IN ('CONFIRMED_AGENT_FAULT', 'AGENT_FAULT_REVERSED')
       AND occurred_at > now() - make_interval(days => $2)`,
    [agentVersionId, WINDOW_DAYS],
  );
  const recent = Math.max(0, Number(rows[0].net));
  const policy = recent >= SUSPEND_AT ? 'suspended' : recent >= 1 ? 'step-up' : 'normal';
  return {
    policy: policy as 'normal' | 'step-up' | 'suspended',
    reason: policy === 'suspended' ? SUSPENDED_REASON : policy === 'step-up' ? STEP_UP_REASON : null,
    confirmed_faults_last_30_days: recent,
    last_fault_at: rows[0].last,
  };
}

export async function agentVersionReputation(agentVersionId: string) {
  const v = (
    await db().query(
      `SELECT v.id, v.version, a.id AS agent_id, a.name, o.id AS operator_id, o.name AS operator_name
       FROM agent_versions v JOIN agents a ON a.id = v.agent_id JOIN operators o ON o.id = a.operator_id WHERE v.id = $1`,
      [agentVersionId],
    )
  ).rows[0];
  if (!v) return null;
  const ev = (
    await db().query<{ faults: string; fault_amount: string; reversed: string }>(
      `SELECT COUNT(*) FILTER (WHERE kind = 'CONFIRMED_AGENT_FAULT') AS faults,
              COALESCE(SUM(weight) FILTER (WHERE kind IN ('CONFIRMED_AGENT_FAULT', 'AGENT_FAULT_REVERSED')), 0) AS fault_amount,
              COUNT(*) FILTER (WHERE kind = 'AGENT_FAULT_REVERSED') AS reversed
       FROM reputation_events WHERE agent_version_id = $1`,
      [agentVersionId],
    )
  ).rows[0];
  const bought = (await db().query<{ total: string | null; n: string }>(`SELECT SUM(total_value) AS total, COUNT(*) AS n FROM orders WHERE agent_version_id = $1 AND status IN ('CAPTURED', 'PARTIALLY_REFUNDED', 'REFUNDED')`, [agentVersionId])).rows[0];
  const pending = (
    await db().query(
      `SELECT c.id, c.case_ref, c.status, c.source, o.order_ref, o.total_value::text AS amount
       FROM cases c JOIN orders o ON o.id = c.order_id
       WHERE o.agent_version_id = $1
         AND NOT EXISTS (SELECT 1 FROM reputation_events r JOIN rulings ru ON ru.id = r.ruling_id WHERE ru.case_id = c.id)
         AND c.status <> 'CLOSED'
       ORDER BY c.created_at DESC`,
      [agentVersionId],
    )
  ).rows;
  const boughtAmount = Number(bought.total ?? 0);
  const faultAmount = Math.max(0, Number(ev.fault_amount));
  const reliability = boughtAmount > 0 ? Math.max(0, Math.min(1, 1 - faultAmount / boughtAmount)) : null;
  return {
    agent_version: { id: v.id, agent_id: v.agent_id, name: v.name, version: v.version, operator: { id: v.operator_id, name: v.operator_name } },
    reliability: reliability === null ? null : Number(reliability.toFixed(3)),
    basis: {
      confirmed_agent_faults: Number(ev.faults) - Number(ev.reversed),
      confirmed_fault_amount: faultAmount.toFixed(2),
      orders: Number(bought.n),
      amount_bought: boughtAmount.toFixed(2),
      formula: '1 - confirmed agent-fault amount / amount bought (finalized rulings only)',
    },
    merchant_policy: await merchantPolicy(agentVersionId),
    pending_cases: pending,
  };
}

export async function operatorReputation(operatorId: string) {
  const op = (await db().query('SELECT id, name FROM operators WHERE id = $1', [operatorId])).rows[0];
  if (!op) return null;
  const ev = (
    await db().query<{ paid: string; paid_amount: string; failed: string; reversed: string }>(
      `SELECT COUNT(*) FILTER (WHERE kind = 'OBLIGATION_PAID') AS paid, COALESCE(SUM(amount_value) FILTER (WHERE kind = 'OBLIGATION_PAID'), 0) AS paid_amount,
              COUNT(*) FILTER (WHERE kind = 'OBLIGATION_FAILED') AS failed, COUNT(*) FILTER (WHERE kind = 'OBLIGATION_REVERSED') AS reversed
       FROM reputation_events WHERE operator_id = $1`,
      [operatorId],
    )
  ).rows[0];
  const outstanding = (
    await db().query<{ n: string; amount: string | null }>(
      `SELECT COUNT(*) AS n, SUM(amount_value) AS amount FROM settlement_obligations
       WHERE operator_id = $1 AND kind = 'RECOVERY' AND status IN ('OPEN', 'BUYER_REFUNDED', 'AWAITING_CONFIRMATION', 'INVOICED')`,
      [operatorId],
    )
  ).rows[0];
  const versions = (await db().query<{ id: string }>('SELECT v.id FROM agent_versions v JOIN agents a ON a.id = v.agent_id WHERE a.operator_id = $1', [operatorId])).rows;
  const paid = Number(ev.paid) - Number(ev.reversed);
  const failed = Number(ev.failed);
  return {
    operator: op,
    accountability: paid + failed > 0 ? Number((paid / (paid + failed)).toFixed(3)) : null,
    basis: { obligations_paid: paid, obligations_failed: failed, paid_amount: Number(ev.paid_amount).toFixed(2), formula: 'obligations paid / (paid + failed), finalized only' },
    outstanding_exposure: { obligations: Number(outstanding.n), amount: Number(outstanding.amount ?? 0).toFixed(2) },
    agent_versions: await Promise.all(versions.map(async (v) => ({ agent_version_id: v.id, ...(await merchantPolicy(v.id)) }))),
  };
}
