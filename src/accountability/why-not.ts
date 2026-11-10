import type { CodeCheck } from './checks';
import { clausesWithStatus } from './evidence';
import type { CaseMaterial } from './material';

export type WhyNot = { verdict: 'AGENT_FAULT' | 'MERCHANT_FAULT' | 'BUYER_REMORSE' | 'THIRD_PARTY_FAULT' | 'INCONCLUSIVE'; text: string; source: 'code' | 'ai' };

/** A clause of the instructions in words for "explicitly required ..." */
function requiredWords(id: string, text: string): string {
  if (id === 'stay.refund_policy') return 'a refundable rate';
  if (id === 'stay.dates') return text.replace(/^dates: /, '');
  if (id === 'attribute.size') return text.replace(/^size must be /, 'size ').replace(/ \(size value and size system\)$/, '');
  return text;
}

const quote = (s: string) => `"${s.trim().replace(/\.$/, '')}."`;

/**
 * For each verdict, one line on why it does not fit this case, built from structured records (tagged code). Where the
 * records alone can't say, the line points at the assessment's reasoning instead (tagged AI). The screen shows the
 * lines for every verdict except the one chosen.
 */
export function whyNotOthers(m: CaseMaterial, checks: CodeCheck[], cf: { compliant_alternatives: unknown[] }): WhyNot[] {
  const clauses = clausesWithStatus(m);
  const broken = clauses.filter((c) => c.code_status === 'VIOLATION' || c.code_status === 'UNVERIFIABLE');
  const line = m.order.lines[0];
  const entries = m.recorder.entries;
  const out: WhyNot[] = [];

  // Agent fault
  if (!broken.length) out.push({ verdict: 'AGENT_FAULT', source: 'code', text: 'Not agent fault: the purchase met every clause of the instructions at checkout.' });
  else if (!cf.compliant_alternatives.length) out.push({ verdict: 'AGENT_FAULT', source: 'code', text: 'Not agent fault: nothing available met every clause of the instructions, so the agent had no compliant choice.' });
  else out.push({ verdict: 'AGENT_FAULT', source: 'ai', text: "Not agent fault: see the assessment's reasoning; the records alone point to the agent's choice." });

  // Merchant fault
  const stay = line?.attributes.stay;
  const refusedRefundable = entries.some((e) => e.kind === 'merchant.cancellation.refused') && stay?.refund_policy === 'REFUNDABLE';
  // Quote the merchant's own words from one description at a time, up to the end of that sentence.
  const said = (re: RegExp) => (line ? [line.variant_description, line.listing_description].map((t) => t.match(re)?.[0]).find(Boolean) : undefined);
  const nonRefundSaid = said(/[^.]*\bnon-?refundable\b[^.]*|[^.]*\bno refunds?\b[^.]*/i);
  const sizingSaid = said(/[^.]*\b(US|UK|EU)\s+sizing\b[^.]*/i);
  if (stay && stay.refund_policy !== 'REFUNDABLE' && nonRefundSaid && !refusedRefundable) {
    out.push({ verdict: 'MERCHANT_FAULT', source: 'code', text: `Not merchant fault: the rate ${stay.refund_policy === 'NON_REFUNDABLE' ? 'was listed as non-refundable' : 'never listed a refund policy'} and its description said ${quote(nonRefundSaid)}` });
  } else if (line && !stay && !line.attributes.unit_system && sizingSaid) {
    out.push({ verdict: 'MERCHANT_FAULT', source: 'code', text: `Not merchant fault: the listing never stated a size system and its description said ${quote(sizingSaid)}` });
  } else if (m.receipt?.status === 'CONFIRMED' && !refusedRefundable) {
    out.push({ verdict: 'MERCHANT_FAULT', source: 'code', text: 'Not merchant fault: the buyer confirmed the purchase on the receipt as received.' });
  } else {
    out.push({ verdict: 'MERCHANT_FAULT', source: 'ai', text: "Not merchant fault: see the assessment's reasoning on what the merchant listed and delivered." });
  }

  // Buyer remorse
  if (broken.length) {
    out.push({ verdict: 'BUYER_REMORSE', source: 'code', text: `Not buyer's remorse: the buyer's signed instructions explicitly required ${requiredWords(broken[0].id, broken[0].text)}.` });
  } else {
    out.push({ verdict: 'BUYER_REMORSE', source: 'ai', text: "Not buyer's remorse: see the assessment's reasoning on what the buyer reported." });
  }

  // Third party
  const outside = m.statements.some((s) => /carrier|courier/i.test(s.party)) || entries.some((e) => /carrier|courier/.test(e.kind));
  out.push(
    outside
      ? { verdict: 'THIRD_PARTY_FAULT', source: 'ai', text: "Not third-party fault: see the assessment's reasoning on the carrier's part." }
      : { verdict: 'THIRD_PARTY_FAULT', source: 'code', text: 'Not third-party fault: nothing in the record involves a carrier or another outside party.' },
  );

  // Inconclusive
  const failing = checks.filter((c) => c.status === 'FAIL');
  out.push(
    failing.length === 0
      ? { verdict: 'INCONCLUSIVE', source: 'code', text: `Not inconclusive: all ${checks.filter((c) => c.status === 'PASS').length} evidence checks pass, and the decision trail is intact and anchored in the PayPal order.` }
      : { verdict: 'INCONCLUSIVE', source: 'ai', text: `Not inconclusive: ${failing.length} evidence ${failing.length === 1 ? 'check fails' : 'checks fail'}, but see the assessment's reasoning on why the rest is enough.` },
  );
  return out;
}
