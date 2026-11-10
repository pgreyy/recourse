import { Who } from '../lib';

export type WhoPaidData = {
  currency: string;
  buyer: { refunded: string; refund_id: string | null };
  merchant: { refunded_to_buyer: string; paypal_fee_not_returned: string; received_from_operator: string; net: string; made_whole: boolean; paypal_fee_on_recovery: string | null; calculation?: Calculation | null };
  operator: { charged: string; capture_id: string | null; agreement: null | { version: number; per_incident_cap: string; aggregate_cap: string; used: string; cap_remaining: string } };
};

export type Calculation = { refunded: string; unreturned_fee: string; fee_on_charge: string; full_recovery: string; capped: boolean; fee_rate: string; fee_source: string };

/** How the operator charge was worked out, in words. */
export function CalculationNote({ c, ccy }: { c: Calculation; ccy: string }) {
  return (
    <span>
      Covers the refund ({c.refunded}), the fee PayPal kept on the refund ({c.unreturned_fee}), and the fee on this charge ({c.fee_on_charge}): {c.full_recovery} {ccy}
      {c.capped ? ', limited by the agreement caps' : ''}. PayPal fee {c.fee_rate}, which {c.fee_source.replace(/^(matches|closest to)/, (w) => (w === 'matches' ? 'matches' : 'is closest to'))}.
    </span>
  );
}

const sign = (v: string) => (Number(v) > 0 ? `+${v}` : Number(v) < 0 ? v : '0.00');

/** Who paid what, once settled: figures only from PayPal-confirmed settlement records. */
export function WhoPaid({ w, compact }: { w: WhoPaidData; compact?: boolean }) {
  const ccy = w.currency;
  if (compact) {
    return (
      <span className="small" style={{ lineHeight: 1.35, display: 'block', whiteSpace: 'normal' }}>
        Buyer <span className="mono">{sign(w.buyer.refunded)}</span> · Merchant <span className="mono">{w.merchant.net}</span> · Operator <span className="mono">-{w.operator.charged}</span>
      </span>
    );
  }
  return (
    <section className="who-paid" aria-labelledby="wp-title">
      <h3 id="wp-title" className="row" style={{ gap: 6 }}>
        Who paid what <Who by="code" />
      </h3>
      <table className="plain">
        <tbody>
          <tr>
            <th scope="row">Buyer</th>
            <td className="num">+{w.buyer.refunded} {ccy}</td>
            <td className="small muted">refunded{w.buyer.refund_id ? `, PayPal refund ${w.buyer.refund_id}` : ''}</td>
          </tr>
          <tr>
            <th scope="row">Merchant</th>
            <td className="num">{w.merchant.net} {ccy}</td>
            <td className="small muted">
              {w.merchant.made_whole ? 'made whole: ' : `short by ${w.merchant.net.replace('-', '')}: `}refunded {w.merchant.refunded_to_buyer}, PayPal kept {w.merchant.paypal_fee_not_returned} on the refund
              {w.merchant.paypal_fee_on_recovery ? ` and ${w.merchant.paypal_fee_on_recovery} on the recovery charge` : ''}; received {w.merchant.received_from_operator} from the operator
              {!w.merchant.made_whole && !w.merchant.calculation ? ' (this charge was made before the charge covered its own PayPal fee)' : ''}
            </td>
          </tr>
          <tr>
            <th scope="row">Operator</th>
            <td className="num">-{w.operator.charged} {ccy}</td>
            <td className="small muted">
              charged{w.operator.capture_id ? `, PayPal capture ${w.operator.capture_id}` : ''}
              {w.operator.agreement ? `; agreement v${w.operator.agreement.version}, ${w.operator.agreement.cap_remaining} of ${w.operator.agreement.aggregate_cap} total cap left` : ''}
            </td>
          </tr>
        </tbody>
      </table>
      <p className="small muted">From PayPal-confirmed settlement records only.</p>
    </section>
  );
}
