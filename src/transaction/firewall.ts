import type { MandateSpec } from '../authorization/mandate-spec';
import { sameMensSize, type UnitSystem } from './sizes';

/**
 * The checkout firewall: deterministic code, no LLM. It compares a cart against the signed mandate
 * and the mandate's history before any money moves.
 *
 *   VIOLATION     a mandate clause is broken, or the agent is not covered by an operator liability
 *                 agreement: checkout is blocked (STEP_UP_REQUIRED)
 *   UNVERIFIABLE  the merchant's data can't show compliance (e.g. a size with no unit_system):
 *                 checkout continues with a recorded warning, because real catalogs often lack units
 *   WARNING       allowed but worth flagging (e.g. fewer units than the mandate asked for)
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
  attributes: { size: string; unit_system: string | null; gender: string | null };
  /** Set when this line is the merchant's suggested substitute for a different variant. */
  substituted_for?: { variant_id: string; listing_id: string };
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
      detail: `mandate requires size ${wantText}; listing gives size ${have.size} with no size system`,
    };
  }
  const gender = want.gender ?? have.gender ?? 'men';
  let same: true | false | 'unknown';
  if (want.unit_system === have.unit_system) same = Number(want.value) === Number(have.size);
  else if (gender === 'men') same = sameMensSize({ size: want.value, unit_system: want.unit_system }, { size: have.size, unit_system: have.unit_system as UnitSystem });
  else same = 'unknown'; // only a men's conversion table exists
  if (same === true) return { rule: 'attribute.size', status: 'PASS', variant_id: line.variant_id, detail: `size ${have.unit_system} ${have.size} matches ${wantText}` };
  if (same === false) return { rule: 'attribute.size', status: 'VIOLATION', variant_id: line.variant_id, detail: `size ${have.unit_system} ${have.size} is not ${wantText}` };
  return { rule: 'attribute.size', status: 'UNVERIFIABLE', variant_id: line.variant_id, detail: `size ${have.unit_system} ${have.size} can't be compared with ${wantText} from the size table` };
}

function genderCheck(wanted: string, line: FirewallLine, rule: string): Check {
  const have = line.attributes.gender;
  if (!have) return { rule, status: 'UNVERIFIABLE', variant_id: line.variant_id, detail: `mandate requires ${wanted}; listing gives no gender` };
  if (eq(have, wanted) || eq(have, 'unisex')) return { rule, status: 'PASS', variant_id: line.variant_id, detail: `gender ${have}` };
  return { rule, status: 'VIOLATION', variant_id: line.variant_id, detail: `listing is ${have}, mandate requires ${wanted}` };
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

  // mandate state and time
  add('mandate.status', input.mandate_status === 'ACTIVE', 'mandate is ACTIVE', `mandate is ${input.mandate_status}`);
  add('mandate.expiry', now < input.expires_at, `mandate valid until ${input.expires_at.toISOString()}`, `mandate expired at ${input.expires_at.toISOString()}`);
  if (merchant.delivery_days === null) {
    checks.push({ rule: 'deadline', status: 'UNVERIFIABLE', detail: `merchant gives no delivery estimate; deadline ${spec.deadline}` });
  } else {
    const eta = new Date(now.getTime() + merchant.delivery_days * 864e5).toISOString().slice(0, 10);
    add('deadline', eta <= spec.deadline, `estimated delivery ${eta}, deadline ${spec.deadline}`, `estimated delivery ${eta} is after the deadline ${spec.deadline}`);
  }

  // money
  add('currency', cart.currency === ccy, `cart in ${ccy}`, `cart is in ${cart.currency}, mandate in ${ccy}`);
  const maxCents = Math.round(Number(spec.max_total.value) * 100);
  const after = history.spent_cents + cart.total_cents;
  add(
    'budget.aggregate',
    after <= maxCents,
    `${money(history.spent_cents, ccy)} spent before + ${money(cart.total_cents, ccy)} now = ${money(after, ccy)} of ${money(maxCents, ccy)}`,
    `${money(history.spent_cents, ccy)} spent before + ${money(cart.total_cents, ccy)} now = ${money(after, ccy)}, over the ${money(maxCents, ccy)} limit`,
  );

  // orders and quantity
  add('orders.max', history.orders_placed + 1 <= spec.max_orders, `order ${history.orders_placed + 1} of at most ${spec.max_orders}`, `${history.orders_placed} order(s) already placed; max_orders is ${spec.max_orders}`);
  add(
    'orders.split',
    spec.allow_split_orders || history.orders_placed === 0,
    spec.allow_split_orders ? 'split orders allowed' : 'first order under this mandate',
    'the mandate does not allow splitting the purchase across orders, and an order was already placed',
  );
  const units = cart.lines.reduce((n, l) => n + l.quantity, 0);
  const remaining = spec.quantity - history.units_bought;
  add('quantity.max', units <= remaining, `${units} unit(s), ${remaining} remaining under the mandate`, `${units} unit(s) in the cart, only ${remaining} remaining under the mandate`);
  if (units < remaining && !spec.allow_split_orders) {
    checks.push({ rule: 'quantity.partial', status: 'WARNING', detail: `${units} of ${remaining} unit(s); split orders are not allowed, so the rest can't be bought later` });
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
    push('category', eq(line.category, spec.category) || line.category.toLowerCase().includes(spec.category.toLowerCase()), `category ${line.category}`, `category ${line.category}, mandate is for ${spec.category}`);
    if (line.substituted_for) {
      const otherProduct = line.substituted_for.listing_id !== line.listing_id;
      if (!otherProduct) {
        checks.push({ rule: 'substitution', status: 'PASS', variant_id: v, detail: `merchant suggested another variant of the same product (${line.substituted_for.variant_id}); not a substitution` });
      } else {
        push('substitution', spec.allow_substitutions, 'substitute product accepted; the mandate allows substitutions', `merchant substituted a different product for ${line.substituted_for.variant_id}; the mandate does not allow substitutions`);
      }
    }
    for (const a of spec.attributes) {
      if (a.name === 'size') {
        checks.push(sizeCheck(a, line));
        if (a.gender) checks.push(genderCheck(a.gender, line, 'attribute.size.gender'));
      } else if (a.name === 'gender') {
        checks.push(genderCheck(a.value, line, 'attribute.gender'));
      } else {
        checks.push({ rule: `attribute.${a.name}`, status: 'UNVERIFIABLE', variant_id: v, detail: `listing has no structured ${a.name}; mandate requires ${a.value}` });
      }
    }
  }

  const violations = checks.filter((c) => c.status === 'VIOLATION');
  const warnings = checks.filter((c) => c.status === 'UNVERIFIABLE' || c.status === 'WARNING');
  return { decision: violations.length ? 'BLOCK' : warnings.length ? 'WARN' : 'PASS', checks, violations, warnings };
}
