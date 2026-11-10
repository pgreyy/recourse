import { agentCoverage } from '../authorization/coverage';
import { appendEntry } from '../evidence/recorder';
import { db } from '../shared/db/pool';
import { HttpError } from '../shared/http/errors';

export type ObligationRow = {
  id: string;
  ruling_id: string;
  case_id: string;
  kind: 'RECOVERY' | 'DISPUTE_RESPONSE' | 'NO_CHARGE' | 'REVERSAL';
  workflow: 'A' | 'B';
  verdict: string;
  status: string;
  amount_value: string;
  currency: string;
  operator_id: string | null;
  liability_agreement_id: string | null;
  agent_version_id: string | null;
  recovered_value: string;
  last_error: string | null;
  checks: unknown;
  created_at: Date;
  updated_at: Date;
};

/**
 * An approved ruling creates exactly one settlement obligation. What it means:
 *   AGENT_FAULT        RECOVERY: refund the buyer, recover from the operator (A: refund + vault charge; B: accept_claim + vault charge)
 *   MERCHANT_FAULT     DISPUTE_RESPONSE: the merchant refunds (A: refund; B: make_offer or accept_claim)
 *   BUYER_REMORSE      A: NO_CHARGE (nothing to pay); B: DISPUTE_RESPONSE with evidence
 *   THIRD_PARTY_FAULT  NO_CHARGE: never charges anyone
 */
export async function ensureObligation(rulingId: string): Promise<ObligationRow> {
  const existing = (await db().query<ObligationRow>(`SELECT * FROM settlement_obligations WHERE ruling_id = $1 AND kind <> 'REVERSAL'`, [rulingId])).rows[0];
  if (existing) return existing;
  const r = (
    await db().query(
      `SELECT ru.id, ru.verdict, ru.status, ru.amount_value::text AS amount, ru.currency, c.id AS case_id, c.case_ref, c.source, o.agent_version_id
       FROM rulings ru JOIN cases c ON c.id = ru.case_id JOIN orders o ON o.id = c.order_id WHERE ru.id = $1`,
      [rulingId],
    )
  ).rows[0];
  if (!r) throw new HttpError(404, 'RESOURCE_NOT_FOUND', `Ruling ${rulingId} not found`);
  if (r.verdict === 'INCONCLUSIVE') throw new HttpError(409, 'INCONCLUSIVE', 'An INCONCLUSIVE ruling creates no obligation.');
  const workflow = r.source === 'PAYPAL_DISPUTE' ? 'B' : 'A';
  const kind =
    r.verdict === 'AGENT_FAULT' ? 'RECOVERY' : r.verdict === 'MERCHANT_FAULT' ? 'DISPUTE_RESPONSE' : r.verdict === 'BUYER_REMORSE' && workflow === 'B' ? 'DISPUTE_RESPONSE' : 'NO_CHARGE';
  const coverage = r.agent_version_id ? await agentCoverage(r.agent_version_id) : null;
  const { rows } = await db().query<ObligationRow>(
    `INSERT INTO settlement_obligations (ruling_id, case_id, kind, workflow, verdict, status, amount_value, currency, operator_id, liability_agreement_id, agent_version_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) ON CONFLICT (ruling_id, kind) DO NOTHING RETURNING *`,
    [
      rulingId, r.case_id, kind, workflow, r.verdict, kind === 'NO_CHARGE' ? 'NO_ACTION' : 'OPEN', r.amount, r.currency.trim(),
      coverage?.operator_id ?? null, coverage?.covered ? coverage.agreement_id : null, r.agent_version_id,
    ],
  );
  const ob = rows[0] ?? (await db().query<ObligationRow>('SELECT * FROM settlement_obligations WHERE ruling_id = $1 AND kind = $2', [rulingId, kind])).rows[0];
  await appendEntry(r.case_ref, 'settlement.obligation_created', { obligation_id: ob.id, ruling_id: rulingId, kind, workflow, verdict: r.verdict, amount: { value: r.amount, currency: r.currency.trim() } });
  return ob;
}
