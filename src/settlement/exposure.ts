/**
 * How much of an operator's liability agreement has been used. Settlement obligations (Phase 5)
 * will be summed here; until that table exists, nothing has been used.
 */
export async function usedUnderAgreement(_agreementId: string): Promise<{ usedCents: number; incidents: number }> {
  return { usedCents: 0, incidents: 0 };
}

export const cents = (value: string | number) => Math.round(Number(value) * 100);
export const money = (c: number, currency: string) => ({ value: (c / 100).toFixed(2), currency });
