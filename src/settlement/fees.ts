import { env } from '../config';

/**
 * PayPal's fee on a payment the merchant receives: a percentage of the amount plus a fixed fee, rounded to the cent.
 * PayPal's breakdowns give the total fee only, so the fixed part is a setting (PAYPAL_FEE_FIXED, default 0.49, PayPal's
 * US fixed fee) and the rate is worked out from PayPal's own fee on the booking capture, then checked to the cent.
 */
export type FeeModel = {
  rate_bp: number; // basis points: 349 = 3.49%
  fixed_cents: number;
  source: string; // how the rate was found, shown in the settlement panel
};

const cents = (v: unknown) => Math.round(Number(v ?? 0) * 100);
const fmt = (c: number) => (c / 100).toFixed(2);

export const feeCents = (amountCents: number, m: FeeModel) => Math.round((amountCents * m.rate_bp) / 10_000 + m.fixed_cents);

export const rateWords = (m: FeeModel) => `${(m.rate_bp / 100).toFixed(2)}% + ${fmt(m.fixed_cents)}`;

/** The fee model, from a PayPal capture's seller_receivable_breakdown when there is one. */
export function feeModelFrom(capture: any): FeeModel {
  const fixed = cents(env('PAYPAL_FEE_FIXED', '0.49'));
  const gross = cents(capture?.seller_receivable_breakdown?.gross_amount?.value ?? capture?.amount?.value);
  const fee = cents(capture?.seller_receivable_breakdown?.paypal_fee?.value);
  if (gross > 0 && fee > fixed) {
    const rate = Math.round(((fee - fixed) / gross) * 10_000);
    const m: FeeModel = { rate_bp: rate, fixed_cents: fixed, source: '' };
    const exact = feeCents(gross, m) === fee;
    m.source = `${exact ? 'matches' : 'closest to'} PayPal's fee of ${fmt(fee)} on the booking capture of ${fmt(gross)}`;
    return m;
  }
  const rate = Number(env('PAYPAL_FEE_RATE_BP', '349'));
  return { rate_bp: rate, fixed_cents: fixed, source: 'configured rate (no PayPal fee breakdown on the booking capture)' };
}

/** The smallest charge that still leaves `targetCents` after PayPal's fee on the charge itself. */
export function grossUp(targetCents: number, m: FeeModel): number {
  let x = Math.ceil(((targetCents + m.fixed_cents) * 10_000) / (10_000 - m.rate_bp));
  while (x - feeCents(x, m) < targetCents) x++;
  while (x - 1 - feeCents(x - 1, m) >= targetCents) x--;
  return x;
}
