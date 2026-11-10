import { db } from '../shared/db/pool';

/**
 * How much of an operator's liability agreement is used: amounts charged to the operator (or invoiced)
 * for agent-fault obligations under that agreement, whether or not PayPal has confirmed them yet.
 */
export async function usedUnderAgreement(agreementId: string): Promise<{ usedCents: number; incidents: number }> {
  const { rows } = await db().query<{ used: string | null; n: string }>(
    `SELECT SUM(recovered_value) AS used, COUNT(*) FILTER (WHERE recovered_value > 0) AS n FROM settlement_obligations
     WHERE liability_agreement_id = $1 AND kind = 'RECOVERY' AND status IN ('AWAITING_CONFIRMATION', 'INVOICED', 'RECOVERED')`,
    [agreementId],
  );
  return { usedCents: Math.round(Number(rows[0].used ?? 0) * 100), incidents: Number(rows[0].n) };
}

export const cents = (value: string | number) => Math.round(Number(value) * 100);
export const money = (c: number, currency: string) => ({ value: (c / 100).toFixed(2), currency });
