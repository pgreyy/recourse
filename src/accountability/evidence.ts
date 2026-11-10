import type { MandateSpec } from '../authorization/mandate-spec';
import { canonicalHash } from '../shared/crypto/canonical';
import { AGENT_FAULT_DEFINITION } from './definitions';
import type { Alternative, CodeCheck } from './checks';
import { scanText, type InjectionFlag } from './injection';
import type { CaseMaterial } from './material';

/** Untrusted text: anything written by a merchant, agent, operator, buyer or carrier. Data, never instructions. */
export type Untrusted = { untrusted: true; author: 'merchant' | 'agent' | 'operator' | 'buyer' | 'carrier'; text: string };
const U = (author: Untrusted['author'], text: string): Untrusted => ({ untrusted: true, author, text });

/** The buyer's instructions as numbered clauses (ids match the firewall's rule names), so citations can be checked. */
export function mandateClauses(spec: MandateSpec): Array<{ id: string; text: string }> {
  const out: Array<{ id: string; text: string }> = [{ id: 'category', text: `category: ${spec.category}` }];
  if (spec.stay) {
    const st = spec.stay;
    out.push({ id: 'stay.city', text: `city: ${st.city}` });
    out.push({ id: 'stay.dates', text: `dates: check-in ${st.check_in}, check-out ${st.check_out}` });
    out.push({ id: 'stay.nights', text: `${st.nights} ${st.nights === 1 ? 'night' : 'nights'}` });
    if (st.min_stars) out.push({ id: 'stay.stars', text: `at least ${st.min_stars} stars` });
    if (st.refund_policy === 'REFUNDABLE') out.push({ id: 'stay.refund_policy', text: 'the rate must be refundable' });
    out.push({ id: 'budget.aggregate', text: `total at most ${spec.max_total.value} ${spec.max_total.currency}, taxes included` });
    out.push({ id: 'quantity.max', text: `${spec.quantity} ${spec.quantity === 1 ? 'room' : 'rooms'}` });
    out.push({ id: 'orders.max', text: `at most ${spec.max_orders} ${spec.max_orders === 1 ? 'booking' : 'bookings'}` });
    out.push({ id: 'substitution', text: spec.allow_substitutions ? 'substitutions allowed' : 'no substitutions (a different hotel or dates than requested)' });
    return out;
  }
  for (const a of spec.attributes) {
    if (a.name === 'size') {
      out.push({ id: 'attribute.size', text: `size must be ${a.unit_system} ${a.value} (size value and size system)` });
      if (a.gender) out.push({ id: 'attribute.size.gender', text: `size is ${a.gender}'s` });
    } else out.push({ id: `attribute.${a.name}`, text: `${a.name}: ${a.value}${a.unit_system ? ` ${a.unit_system}` : ''}` });
  }
  if (spec.brands_allowed.length) out.push({ id: 'brand.allowlist', text: `brand must be one of: ${spec.brands_allowed.join(', ')}` });
  if (spec.merchants_allowed?.length) out.push({ id: 'merchant.allowlist', text: `merchant must be one of: ${spec.merchants_allowed.join(', ')}` });
  out.push({ id: 'budget.aggregate', text: `total spend across all orders at most ${spec.max_total.value} ${spec.max_total.currency}, tax and shipping included` });
  out.push({ id: 'quantity.max', text: `quantity ${spec.quantity}` });
  out.push({ id: 'orders.max', text: `at most ${spec.max_orders} ${spec.max_orders === 1 ? 'order' : 'orders'}` });
  out.push({ id: 'substitution', text: spec.allow_substitutions ? 'substitutions allowed' : 'no substitutions (a different product than requested)' });
  out.push({ id: 'deadline', text: `delivered by ${spec.deadline}` });
  return out;
}

const RANK = { PASS: 0, NOT_CHECKED: 0, WARNING: 1, UNVERIFIABLE: 2, VIOLATION: 3 } as const;
export type ClauseStatus = keyof typeof RANK;

/** Each clause with what the checkout firewall (code) found for it: the worst status among its checks. */
export function clausesWithStatus(m: CaseMaterial): Array<{ id: string; text: string; code_status: ClauseStatus }> {
  return mandateClauses(m.mandate.spec).map((c) => {
    const statuses = m.order.firewall.checks.filter((k) => k.rule === c.id).map((k) => k.status as ClauseStatus);
    const worst = statuses.reduce<ClauseStatus>((a, b) => (RANK[b] > RANK[a] ? b : a), statuses.length ? 'PASS' : 'NOT_CHECKED');
    return { ...c, code_status: worst };
  });
}

function timeline(m: CaseMaterial) {
  return m.recorder.entries.map((e) => {
    const p = e.payload as any;
    const base = { seq: e.seq, kind: e.kind };
    switch (true) {
      case e.kind === 'agent.run.started':
        return { ...base, summary: `agent ${p.agent?.name} v${p.agent?.version} started under instructions v${p.mandate?.version}` };
      case e.kind === 'agent.tool_call':
        return {
          ...base,
          summary: `agent called ${p.tool}${p.input?.items ? ` with ${p.input.items.map((i: { variant_id: string }) => i.variant_id).join(', ')}` : ''}${p.result?.status ? ` -> ${p.result.status}` : ''}`,
          agent_reasoning: p.reasoning ? U('agent', String(p.reasoning)) : undefined,
        };
      case e.kind === 'agent.tool_result':
        return { ...base, summary: `${p.tool} returned${p.result?.status ? ` ${p.result.status}` : ''}${p.result?.error ? ` an error: ${p.result.error}` : ''}` };
      case e.kind.startsWith('merchant.cart.'):
        return {
          ...base,
          summary: `merchant cart ${p.cart_id}: ${p.status}; lines ${(p.lines ?? []).map((l: { variant_id: string }) => l.variant_id).join(', ')}`,
          merchant_messages: (p.validation_issues ?? []).map((i: { message: string }) => U('merchant', i.message)),
          suggested_substitutes: (p.validation_issues ?? []).filter((i: { suggested_substitute: unknown }) => i.suggested_substitute).map((i: { suggested_substitute: unknown }) => i.suggested_substitute),
        };
      case e.kind === 'checkout.firewall':
        return { ...base, summary: `firewall decision ${p.decision}`, warnings: (p.warnings ?? []).map((w: { detail: string }) => w.detail), violations: (p.violations ?? []).map((w: { detail: string }) => w.detail) };
      case e.kind === 'checkout.started':
        return { ...base, summary: `purchase decided (${p.compliance})`, proceeded_despite_warnings: p.proceeded_despite_warnings ?? null };
      case e.kind === 'buyer.issue.reported':
        return { ...base, summary: 'buyer reported an issue from the receipt', buyer_text: U('buyer', String(p.description ?? '')) };
      case e.kind === 'buyer.receipt.confirmed':
        return { ...base, summary: 'buyer confirmed the purchase on the receipt (signed)' };
      case e.kind === 'operator.statement':
        return { ...base, summary: 'operator added a statement', operator_text: U('operator', String(p.text ?? '')) };
      case e.kind === 'carrier.note':
        return { ...base, summary: 'carrier delivery note', carrier_text: U('carrier', String(p.text ?? '')) };
      default:
        return { ...base, summary: e.kind };
    }
  });
}

export type EvidencePack = ReturnType<typeof assemble>;

function assemble(m: CaseMaterial, checks: CodeCheck[], cf: { compliant_alternatives: Alternative[]; note: string }, facts: Array<{ fact: string; seqs: number[] }>) {
  return {
    pack_version: 1,
    case: {
      case_ref: m.case.case_ref,
      source: m.case.source,
      opened_by: m.case.opened_by,
      buyer_report: m.case.buyer_report ? U('buyer', m.case.buyer_report) : null,
      paypal_dispute: m.case.dispute ? { id: m.case.dispute.id, reason: m.case.dispute.reason, status: m.case.dispute.status, buyer_notes: m.case.dispute.buyer_notes.map((t) => U('buyer', t)) } : null,
    },
    agent_fault_definition: AGENT_FAULT_DEFINITION,
    agent: m.agent,
    mandate: {
      mandate_version: m.mandate.version,
      buyer_instruction: U('buyer', m.mandate.source_text),
      clauses: clausesWithStatus(m),
    },
    purchase: {
      order_ref: m.order.order_ref,
      total: { value: m.order.total_value, currency: m.order.currency },
      lines: m.order.lines.map((l) => ({
        variant_id: l.variant_id,
        name: l.name,
        brand: l.brand,
        quantity: l.quantity,
        price: l.price,
        structured_attributes: l.attributes,
        variant_description: U('merchant', l.variant_description),
        listing_description: U('merchant', l.listing_description),
      })),
      firewall_at_checkout: { decision: m.order.firewall.decision, warnings: m.order.firewall.warnings.map((w) => w.detail), violations: m.order.firewall.violations.map((w) => w.detail) },
    },
    receipt: m.receipt ? { status: m.receipt.status } : null,
    delivery: m.delivery ? { tracking_number: m.delivery.tracking_number, carrier_note: m.delivery.carrier_note ? U('carrier', m.delivery.carrier_note) : null } : null,
    statements: m.statements.map((s) => ({ party: s.party, text: U(s.party.toLowerCase() as Untrusted['author'], s.text) })),
    timeline: timeline(m),
    code_facts: {
      checks: checks.map((c) => ({ id: c.id, status: c.status, detail: c.detail })),
      decision_facts: facts.map((f) => f.fact),
      counterfactual: { compliant_alternatives: cf.compliant_alternatives, note: cf.note },
    },
  };
}

/** Collect every untrusted text in the pack and scan it for instruction-like content. */
function scanPack(pack: EvidencePack): InjectionFlag[] {
  const flags: InjectionFlag[] = [];
  const walk = (v: unknown, path: string) => {
    if (!v || typeof v !== 'object') return;
    if ((v as Untrusted).untrusted === true) {
      flags.push(...scanText(path, (v as Untrusted).author, (v as Untrusted).text));
      return;
    }
    if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${path}[${i}]`));
    else for (const [k, x] of Object.entries(v)) walk(x, path ? `${path}.${k}` : k);
  };
  walk(pack, '');
  return flags;
}

export function buildEvidencePack(m: CaseMaterial, checks: CodeCheck[], cf: { compliant_alternatives: Alternative[]; note: string }, facts: Array<{ fact: string; seqs: number[] }>) {
  const pack = assemble(m, checks, cf, facts);
  const flags = scanPack(pack);
  return { pack, hash: canonicalHash(pack), flags };
}
