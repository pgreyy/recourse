import type { MandateSpec } from '../authorization/mandate-spec';
import type { LineAttrs } from './catalog';
import { plural } from '../shared/words';
import { sameMensSize, type UnitSystem } from './sizes';

/**
 * The checkout firewall: deterministic code, no LLM. It compares a cart against the signed instructions
 * and the instructions' history before any money moves.
 *
 *   VIOLATION     a clause of the instructions is broken, or the agent is not covered by an operator liability
 *                 agreement: checkout is blocked (STEP_UP_REQUIRED)
 *   UNVERIFIABLE  the merchant's data can't show compliance (e.g. a size with no unit_system):
 *                 checkout continues with a recorded warning, because real catalogs often lack units
 *   WARNING       allowed but worth flagging (e.g. fewer units than the instructions asked for)
 *   PASS
 */
export type CheckStatus = 'PASS' | 'WARNING' | 'UNVERIFIABLE' | 'VIOLATION';
export type Check = { rule: string; status: CheckStatus; detail: string; variant_id?: string };
export type FirewallResult = {
  decision: 'PASS' | 'WARN' | 'BLOCK';
  checks: Check[];
  violations: Check[];
  warnings: Check[];
};

export type FirewallLine = {
  variant_id: string;
  listing_id: string;
  name: string;
  brand: string;
  category: string;
  quantity: number;
  unit_price_cents: number;
  attributes: LineAttrs;
  /** Set when this line is the merchant's suggested substitute for a different variant. */
  substituted_for?: { variant_id: string; listing_id: string; hotel?: string; check_in?: string };
};

export type FirewallInput = {
  spec: MandateSpec;
  mandate_status: string;
  expires_at: Date;
  history: { spent_cents: number; orders_placed: number; units_bought: number };
  cart: { currency: string; total_cents: number; lines: FirewallLine[] };
  merchant: { id: string; name: string; delivery_days: number | null };
  /** The buying agent's liability coverage. null = buyer-initiated checkout (no agent involved). */
  agent: { agent_version_id: string; covered: boolean; detail: string; policy?: 'normal' | 'step-up' | 'suspended'; policy_reason?: string | null } | null;
  now: Date;
};

const money = (c: number, ccy: string) => `${(c / 100).toFixed(2)} ${ccy}`;
const eq = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

function sizeCheck(want: MandateSpec['attributes'][number], line: FirewallLine): Check {
  const have = line.attributes;
  const wantText = `${want.unit_system} ${want.value}`;
  if (!have.unit_system) {
    return {
      rule: 'attribute.size',
      status: 'UNVERIFIABLE',
      variant_id: line.variant_id,
      detail: `the instructions require size ${wantText}; listing gives size ${have.size ?? '(none)'} with no size system`,
    };
  }
  if (!have.size) return { rule: 'attribute.size', status: 'UNVERIFIABLE', variant_id: line.variant_id, detail: `the instructions require size ${wantText}; listing gives no size` };
  const size = have.size;
  const gender = want.gender ?? have.gender ?? 'men';
  let same: true | false | 'unknown';
  if (want.unit_system === have.unit_system) same = Number(want.value) === Number(size);
  else if (gender === 'men') same = sameMensSize({ size: want.value, unit_system: want.unit_system }, { size, unit_system: have.unit_system as UnitSystem });
  else same = 'unknown'; // only a men's conversion table exists
  if (same === true) return { rule: 'attribute.size', status: 'PASS', variant_id: line.variant_id, detail: `size ${have.unit_system} ${have.size} matches ${wantText}` };
  if (same === false) return { rule: 'attribute.size', status: 'VIOLATION', variant_id: line.variant_id, detail: `size ${have.unit_system} ${have.size} is not ${wantText}` };
  return { rule: 'attribute.size', status: 'UNVERIFIABLE', variant_id: line.variant_id, detail: `size ${have.unit_system} ${have.size} can't be compared with ${wantText} from the size table` };
}

function genderCheck(wanted: string, line: FirewallLine, rule: string): Check {
  const have = line.attributes.gender;
  if (!have) return { rule, status: 'UNVERIFIABLE', variant_id: line.variant_id, detail: `the instructions require ${wanted}; listing gives no gender` };
  if (eq(have, wanted) || eq(have, 'unisex')) return { rule, status: 'PASS', variant_id: line.variant_id, detail: `gender ${have}` };
  return { rule, status: 'VIOLATION', variant_id: line.variant_id, detail: `listing is ${have}, the instructions require ${wanted}` };
}

const fmtDay = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });

/** A hotel rate against the stay in the instructions: city, exact dates, nights, minimum stars, refund policy. */
function stayChecks(want: NonNullable<MandateSpec['stay']>, line: FirewallLine): Check[] {
  const v = line.variant_id;
  const have = line.attributes.stay;
  if (!have) return [{ rule: 'stay', status: 'VIOLATION', variant_id: v, detail: 'the instructions are for a hotel stay; this item is not a hotel rate' }];
  const out: Check[] = [];
  const c = (rule: string, status: CheckStatus, detail: string) => out.push({ rule, status, variant_id: v, detail });
  c('stay.city', eq(have.city, want.city) ? 'PASS' : 'VIOLATION', eq(have.city, want.city) ? `${have.hotel} is in ${have.city}` : `${have.hotel} is in ${have.city}; the instructions say ${want.city}`);
  const sameDates = have.check_in === want.check_in && have.check_out === want.check_out;
  c('stay.dates', sameDates ? 'PASS' : 'VIOLATION', sameDates ? `${fmtDay(have.check_in)} to ${fmtDay(have.check_out)}` : `rate is ${fmtDay(have.check_in)} to ${fmtDay(have.check_out)}; the instructions say ${fmtDay(want.check_in)} to ${fmtDay(want.check_out)}`);
  c('stay.nights', have.nights === want.nights ? 'PASS' : 'VIOLATION', have.nights === want.nights ? `${plural(have.nights, 'night')}` : `${plural(have.nights, 'night')}; the instructions say ${want.nights}`);
  if (want.min_stars) {
    if (have.stars === null) c('stay.stars', 'UNVERIFIABLE', `the instructions require ${want.min_stars} stars or more; the rate gives no star rating`);
    else c('stay.stars', have.stars >= want.min_stars ? 'PASS' : 'VIOLATION', have.stars >= want.min_stars ? `${have.stars} stars` : `${have.stars} stars; the instructions require ${want.min_stars} or more`);
  }
  if (want.refund_policy === 'REFUNDABLE') {
    // Same pattern as a size with no size system: missing merchant data can't prove compliance, so it warns.
    if (have.refund_policy === 'REFUNDABLE') c('stay.refund_policy', 'PASS', 'refundable rate');
    else if (have.refund_policy === 'NON_REFUNDABLE') c('stay.refund_policy', 'VIOLATION', 'the rate is non-refundable; the instructions require refundable');
    else c('stay.refund_policy', 'UNVERIFIABLE', 'the instructions require a refundable rate; the rate gives no refund policy');
  }
  return out;
}

export function runFirewall(input: FirewallInput): FirewallResult {
  const { spec, cart, history, merchant, now } = input;
  const ccy = spec.max_total.currency;
  const checks: Check[] = [];
  const add = (rule: string, ok: boolean, okText: string, badText: string, bad: CheckStatus = 'VIOLATION') =>
    checks.push({ rule, status: ok ? 'PASS' : bad, detail: ok ? okText : badText });

  // operator incentive: an agent nobody has agreed to pay for can only buy with the buyer's fresh approval
  if (input.agent) {
    checks.push({ rule: 'operator.coverage', status: input.agent.covered ? 'PASS' : 'VIOLATION', detail: input.agent.detail });
    // merchant policy from reputation: step-up or suspended agents need the buyer's fresh approval
    const policy = input.agent.policy ?? 'normal';
    checks.push({ rule: 'agent.reputation', status: policy === 'normal' ? 'PASS' : 'VIOLATION', detail: policy === 'normal' ? 'merchant policy normal' : (input.agent.policy_reason ?? policy) });
  } else {
    checks.push({ rule: 'operator.coverage', status: 'PASS', detail: 'no agent: buyer-initiated checkout' });
  }

  // state of the instructions and time
  add('mandate.status', input.mandate_status === 'ACTIVE', 'the instructions are ACTIVE', `the instructions are ${input.mandate_status}`);
  add('mandate.expiry', now < input.expires_at, `instructions valid until ${input.expires_at.toISOString()}`, `instructions expired at ${input.expires_at.toISOString()}`);
  if (spec.stay) {
    // A stay has no delivery: its dates are checked per line instead.
  } else if (merchant.delivery_days === null) {
    checks.push({ rule: 'deadline', status: 'UNVERIFIABLE', detail: `merchant gives no delivery estimate; deadline ${spec.deadline}` });
  } else {
    const eta = new Date(now.getTime() + merchant.delivery_days * 864e5).toISOString().slice(0, 10);
    add('deadline', eta <= spec.deadline, `estimated delivery ${eta}, deadline ${spec.deadline}`, `estimated delivery ${eta} is after the deadline ${spec.deadline}`);
  }

  // money
  add('currency', cart.currency === ccy, `cart in ${ccy}`, `cart is in ${cart.currency}, the instructions in ${ccy}`);
  const maxCents = Math.round(Number(spec.max_total.value) * 100);
  const after = history.spent_cents + cart.total_cents;
  add(
    'budget.aggregate',
    after <= maxCents,
    `${money(history.spent_cents, ccy)} spent before + ${money(cart.total_cents, ccy)} now = ${money(after, ccy)} of ${money(maxCents, ccy)}`,
    `${money(history.spent_cents, ccy)} spent before + ${money(cart.total_cents, ccy)} now = ${money(after, ccy)}, over the ${money(maxCents, ccy)} limit`,
  );

  // orders and quantity
  add('orders.max', history.orders_placed + 1 <= spec.max_orders, `order ${history.orders_placed + 1} of at most ${spec.max_orders}`, `${plural(history.orders_placed, 'order')} already placed; the instructions allow ${spec.max_orders}`);
  add(
    'orders.split',
    spec.allow_split_orders || history.orders_placed === 0,
    spec.allow_split_orders ? 'split orders allowed' : 'first order under these instructions',
    'the instructions do not allow splitting the purchase across orders, and an order was already placed',
  );
  const units = cart.lines.reduce((n, l) => n + l.quantity, 0);
  const remaining = spec.quantity - history.units_bought;
  add('quantity.max', units <= remaining, `${plural(units, 'unit')}, ${remaining} remaining under the instructions`, `${plural(units, 'unit')} in the cart, only ${remaining} remaining under the instructions`);
  if (units < remaining && !spec.allow_split_orders) {
    checks.push({ rule: 'quantity.partial', status: 'WARNING', detail: `${units} of ${plural(remaining, 'unit')}; split orders are not allowed, so the rest can't be bought later` });
  }

  // merchant
  if (spec.merchants_allowed?.length) {
    const ok = spec.merchants_allowed.some((m) => eq(m, merchant.name) || eq(m, merchant.id));
    add('merchant.allowlist', ok, `${merchant.name} is allowed`, `${merchant.name} is not in ${spec.merchants_allowed.join(', ')}`);
  }

  // per line
  for (const line of cart.lines) {
    const v = line.variant_id;
    const push = (rule: string, ok: boolean, okText: string, badText: string) =>
      checks.push({ rule, status: ok ? 'PASS' : 'VIOLATION', detail: ok ? okText : badText, variant_id: v });
    if (spec.brands_allowed.length) {
      push('brand.allowlist', spec.brands_allowed.some((b) => eq(b, line.brand)), `${line.brand} is allowed`, `${line.brand} is not in ${spec.brands_allowed.join(', ')}`);
    }
    push('category', eq(line.category, spec.category) || line.category.toLowerCase().includes(spec.category.toLowerCase()), `category ${line.category}`, `category ${line.category}; the instructions are for ${spec.category}`);
    if (line.substituted_for) {
      // Another rate of the same hotel for the same dates is the same stay, as another variant is the same product.
      const sameStay = Boolean(line.attributes.stay && line.substituted_for.hotel && eq(line.attributes.stay.hotel, line.substituted_for.hotel) && line.substituted_for.check_in === line.attributes.stay.check_in);
      const otherProduct = line.substituted_for.listing_id !== line.listing_id && !sameStay;
      if (!otherProduct) {
        checks.push({ rule: 'substitution', status: 'PASS', variant_id: v, detail: sameStay ? `merchant suggested another rate of the same hotel for the same dates; not a substitution` : `merchant suggested another variant of the same product (${line.substituted_for.variant_id}); not a substitution` });
      } else {
        push('substitution', spec.allow_substitutions, 'substitute product accepted; the instructions allow substitutions', `merchant substituted a different product for ${line.substituted_for.variant_id}; the instructions do not allow substitutions`);
      }
    }
    if (spec.stay) checks.push(...stayChecks(spec.stay, line));
    for (const a of spec.attributes) {
      if (a.name === 'size') {
        checks.push(sizeCheck(a, line));
        if (a.gender) checks.push(genderCheck(a.gender, line, 'attribute.size.gender'));
      } else if (a.name === 'gender') {
        checks.push(genderCheck(a.value, line, 'attribute.gender'));
      } else {
        checks.push({ rule: `attribute.${a.name}`, status: 'UNVERIFIABLE', variant_id: v, detail: `listing has no structured ${a.name}; the instructions require ${a.value}` });
      }
    }
  }

  const violations = checks.filter((c) => c.status === 'VIOLATION');
  const warnings = checks.filter((c) => c.status === 'UNVERIFIABLE' || c.status === 'WARNING');
  return { decision: violations.length ? 'BLOCK' : warnings.length ? 'WARN' : 'PASS', checks, violations, warnings };
}
