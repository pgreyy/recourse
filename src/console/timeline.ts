import type { RecorderEntry } from '../evidence/recorder';
import { fixPlural, plural } from '../shared/words';
import { DEMO_MERCHANT, readCatalogFile } from '../transaction/catalog';

/** One row of the timeline as the screens show it. A recorder entry can give more than one row (for example a cart
 *  that also carries the merchant's suggested substitute); extra rows share the step number and are marked `sub`. */
export type TimelineRow = {
  key: string;
  seq: number;
  sub?: boolean;
  kind: string;
  recorded_at: Date | string;
  title: string;
  detail: string;
  tone: 'normal' | 'warn' | 'block' | 'money' | 'ok';
  payload: unknown;
  hash: string;
};

type Attrs = { size?: string; unit_system?: string | null; gender?: string | null };

let names: Map<string, { name: string; attrs: Attrs }> | null = null;
function catalog() {
  if (!names) {
    names = new Map();
    try {
      for (const l of readCatalogFile().listings) for (const v of l.variants) names.set(v.id, { name: l.name, attrs: v.attributes });
    } catch {
      /* no catalog file: fall back to the id below */
    }
  }
  return names;
}
export const isKnownVariant = (id: string) => catalog().has(id);
/** Product names from the merchant's catalog file, so the timeline never shows a raw variant id. */
function productName(variantId: string): string {
  const known = catalog().get(variantId)?.name;
  if (known) return known;
  // Unknown variant: turn "kestrel-glide-4-us-10" into "Kestrel Glide 4".
  const words = variantId.split('-').filter((w, i, a) => !(i >= a.length - 2 && /^(us|uk|eu|\d+(\.\d+)?)$/i.test(w)));
  return words.map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

function sizeWords(a?: Attrs): string {
  if (!a?.size) return '';
  return a.unit_system ? `${a.unit_system} ${a.size}` : `size ${a.size} (no size system given)`;
}

/** "Kestrel Glide 4, US 10" */
export function itemWords(variantId: string, attrs?: Attrs): string {
  const size = sizeWords(attrs ?? catalog().get(variantId)?.attrs);
  return size ? `${productName(variantId)}, ${size}` : productName(variantId);
}


const VERDICT: Record<string, string> = {
  AGENT_FAULT: 'agent fault',
  BUYER_REMORSE: "buyer's remorse",
  MERCHANT_FAULT: 'merchant fault',
  THIRD_PARTY_FAULT: 'third-party fault',
  INCONCLUSIVE: 'inconclusive',
};
export const verdictWords = (v: string | undefined) => (v ? (VERDICT[v] ?? v.toLowerCase().replace(/_/g, ' ')) : '');

const ACTION: Record<string, string> = {
  REFUND_BUYER: 'Refund the buyer',
  CHARGE_OPERATOR: "Charge the operator's saved PayPal",
  INVOICE_OPERATOR: 'Invoice the operator',
  REFUND_OPERATOR: 'Refund the operator',
  DISPUTE_PROVIDE_EVIDENCE: 'Send evidence to the PayPal dispute',
  DISPUTE_ESCALATE: 'Escalate the PayPal dispute',
  DISPUTE_ACCEPT_CLAIM: 'Accept the PayPal dispute claim',
  DISPUTE_MAKE_OFFER: 'Make an offer in the PayPal dispute',
};
const actionWords = (a: string | undefined) => (a ? (ACTION[a] ?? a.toLowerCase().replace(/_/g, ' ')) : '');
const PAYPAL_ID: Record<string, string> = { refund_id: 'refund', capture_id: 'capture', order_id: 'order', invoice_id: 'invoice', dispute_id: 'dispute' };
const money = (a?: { value?: string; currency?: string; currency_code?: string }) => (a?.value ? `${a.value} ${a.currency ?? a.currency_code ?? ''}`.trim() : '');
const quoted = (s: unknown) => (s ? `“${String(s).trim()}”` : '');
/** The agent's one-line reason, with any variant id it wrote shown as the product it names. */
const reason = (s: unknown) =>
  quoted(s ? String(s).replace(/\b[a-z0-9]+(?:-[a-z0-9.]+){2,}\b/g, (id) => (catalog().has(id) ? itemWords(id) : id)) : '');

type Line = { variant_id: string; price?: string; quantity?: number; available?: boolean; attributes?: Attrs };
type Issue = { message?: string; variant_id?: string | null; specific_issue?: string; suggested_substitute?: { variant_id: string; attributes?: Attrs } | null };

/** The recorder as plain-language rows, in recorder order. Reads the whole trail so a later row can refer to an
 *  earlier one (the agent switching to the merchant's suggested substitute). */
export function timelineView(entries: RecorderEntry[]): TimelineRow[] {
  const suggested = new Set<string>();
  const out: TimelineRow[] = [];
  for (const e of entries) {
    const p = e.payload as any;
    const row = (title: string, detail = '', tone: TimelineRow['tone'] = 'normal', sub = false): TimelineRow => ({
      key: sub ? `${e.seq}.${out.length}` : String(e.seq),
      seq: e.seq,
      sub: sub || undefined,
      kind: e.kind,
      recorded_at: e.created_at,
      title,
      detail: fixPlural(detail),
      tone,
      payload: e.payload,
      hash: e.hash,
    });
    const items = (list?: Array<{ variant_id: string; quantity?: number }>) => (list ?? []).map((i) => itemWords(i.variant_id)).join(', ');
    switch (e.kind) {
      case 'agent.run.started':
        out.push(row(`${p.agent?.name} v${p.agent?.version} started shopping`, `under mandate v${p.mandate?.version}, ${p.budget_remaining} left to spend${p.dry_run ? ', dry run (nothing is charged)' : ''}`));
        break;
      case 'agent.tool_call': {
        const why = reason(p.reasoning);
        if (p.tool === 'search_catalog') {
          const brands = p.input?.brands?.length ? ` for ${p.input.brands.join(' or ')}` : '';
          const max = p.input?.max_price ? ` up to ${p.input.max_price}` : '';
          out.push(row(`Agent searched the ${DEMO_MERCHANT.name} catalog${brands}${max}`, why));
        } else if (p.tool === 'create_cart') {
          out.push(row(`Agent asked for ${items(p.input?.items)}`, why));
        } else if (p.tool === 'update_cart') {
          const took = (p.input?.items ?? []).some((i: { variant_id: string }) => suggested.has(i.variant_id));
          out.push(took ? row(`Agent accepted the merchant's suggestion: ${items(p.input?.items)}`, why, 'warn') : row(`Agent changed the cart to ${items(p.input?.items)}`, why));
        } else if (p.tool === 'checkout') {
          out.push(row('Agent called checkout', why));
        } else {
          out.push(row(`Agent called ${p.tool}`, why));
        }
        // Older runs recorded the call after its result, in one entry.
        if (p.result?.error) out.push(row('The call failed', String(p.result.error), 'block', true));
        break;
      }
      case 'agent.tool_result': {
        const r = p.result ?? {};
        if (r.error) out.push(row(`${p.tool === 'checkout' ? 'Checkout' : 'The call'} failed`, String(r.error), 'block'));
        else if (p.tool === 'search_catalog') out.push(row(r.repeated ? 'Search repeated: same results' : `Search found ${plural((r.listings ?? []).length, 'listing')}`));
        else if (p.tool === 'checkout')
          out.push(
            row(
              r.status === 'CAPTURED' ? 'Checkout answered: purchase complete' : r.status === 'STEP_UP_REQUIRED' ? 'Checkout answered: the buyer must approve at PayPal' : r.status === 'DRY_RUN' ? 'Checkout answered: dry run, nothing charged' : `Checkout answered: ${String(r.status ?? '').toLowerCase()}`,
              (r.warnings ?? []).length ? `${plural(r.warnings.length, 'warning')} passed back to the agent` : '',
              r.status === 'STEP_UP_REQUIRED' ? 'block' : 'normal',
            ),
          );
        else out.push(row(`Merchant answered: cart ${r.status === 'READY' ? 'ready to pay' : 'not ready'}`));
        break;
      }
      case 'merchant.cart.created':
      case 'merchant.cart.updated':
      case 'merchant.cart.viewed': {
        const lines = (p.lines ?? []) as Line[];
        const issues = (p.validation_issues ?? []) as Issue[];
        const what = e.kind.endsWith('created') ? 'Cart created' : e.kind.endsWith('updated') ? 'Cart updated' : 'Cart checked before payment';
        const out_ = lines.filter((l) => l.available === false);
        const words = lines.map((l) => itemWords(l.variant_id, l.attributes)).join(', ');
        if (out_.length) out.push(row(`${what}: ${out_.map((l) => itemWords(l.variant_id, l.attributes)).join(', ')} ${out_.length === 1 ? 'is' : 'are'} out of stock`, '', 'warn'));
        else out.push(row(`${what}: ${words}`, `${p.totals?.total?.value ?? ''} ${p.totals?.total?.currency_code ?? ''}, ${p.status === 'READY' ? 'ready to pay' : 'not ready'}`.replace(/^ +, /, '')));
        for (const i of issues) {
          if (!i.suggested_substitute) continue;
          suggested.add(i.suggested_substitute.variant_id);
          out.push(row(`${DEMO_MERCHANT.name} suggested a substitute: ${itemWords(i.suggested_substitute.variant_id, i.suggested_substitute.attributes)}`, i.message ? `Merchant's message: ${quoted(i.message)}` : '', 'warn', true));
        }
        break;
      }
      case 'checkout.firewall': {
        const checks = (p.checks ?? []) as Array<{ rule: string; status: string; detail: string }>;
        const warns = checks.filter((c) => c.status === 'WARN' || c.status === 'WARNING' || c.status === 'UNVERIFIABLE');
        const blocks = checks.filter((c) => c.status === 'BLOCK' || c.status === 'FAIL');
        const title = blocks.length ? 'Firewall blocked checkout' : warns.length ? 'Firewall warning' : 'Firewall passed';
        const detail = (blocks.length ? blocks : warns).map((c) => c.detail).join('; ') || `all ${plural(checks.length, 'check')} passed`;
        out.push(row(title, detail, blocks.length ? 'block' : warns.length ? 'warn' : 'ok'));
        break;
      }
      case 'checkout.dry_run': {
        // A rehearsal on a draft mandate: the draft status is expected, so it is reported apart from the real findings.
        const all = (p.checks ?? []) as Array<{ rule: string; status: string; detail: string }>;
        const draft = all.some((c) => c.rule === 'mandate.status' && /DRAFT/.test(c.detail));
        const checks = all.filter((c) => !(c.rule === 'mandate.status' && /DRAFT/.test(c.detail)));
        const warns = checks.filter((c) => c.status === 'WARN' || c.status === 'WARNING' || c.status === 'UNVERIFIABLE');
        const blocks = checks.filter((c) => c.status === 'BLOCK' || c.status === 'FAIL' || c.status === 'VIOLATION');
        const title = blocks.length ? 'Firewall would block checkout (dry run)' : warns.length ? 'Firewall warning (dry run)' : 'Firewall would pass (dry run)';
        const found = (blocks.length ? blocks : warns).map((c) => c.detail).join('; ');
        out.push(row(title, [found, draft ? 'The mandate is still a draft; a real run needs the buyer to approve it at PayPal' : ''].filter(Boolean).join('. '), blocks.length ? 'block' : warns.length ? 'warn' : 'ok'));
        break;
      }
      case 'checkout.started':
        if (p.proceeded_despite_warnings) out.push(row('Checkout went ahead despite the warning', `the warning at step ${p.proceeded_despite_warnings.warning_entry_seq} was not resolved`, 'warn'));
        else out.push(row('Checkout started', (p.lines ?? []).map((l: Line & { name?: string }) => `${l.name ?? productName(l.variant_id)}${l.attributes ? `, ${sizeWords(l.attributes)}` : ''}`).join(', ')));
        break;
      case 'checkout.step_up_required':
        out.push(row('Buyer approval required at PayPal', (p.violations ?? []).map((v: { detail: string }) => v.detail).join('; '), 'block'));
        break;
      case 'paypal.order.created':
        out.push(row('PayPal order created', `order ${p.paypal_order_id}${p.status ? `, ${String(p.status).toLowerCase()}` : ''}`, 'money'));
        break;
      case 'paypal.anchor.verified':
        out.push(row(p.all_match ? 'Decision trail anchored in the PayPal order' : 'Anchor mismatch in the PayPal order', 'mandate hash and recorder head re-read from PayPal', p.all_match ? 'ok' : 'block'));
        break;
      case 'paypal.tracker.added':
        out.push(row('Tracking added at PayPal', p.tracking_number ?? ''));
        break;
      case 'checkout.completed':
        out.push(row('Purchase captured', `${money(p.amount)}, capture ${p.paypal_capture_id ?? ''}`.replace(/, capture $/, ''), 'money'));
        break;
      case 'agent.run.finished':
        out.push(row(`Run finished: ${String(p.outcome ?? '').toLowerCase().replace(/_/g, ' ')}`, `${plural(Number(p.tool_calls ?? 0), 'tool call')}, ${String(p.model ?? '').replace(/^\w+\//, '')}`));
        break;
      case 'agent.run.failed':
        out.push(row('Run failed', p.error ?? '', 'block'));
        break;
      case 'buyer.issue.reported':
        out.push(row('Buyer reported an issue', quoted(p.description)));
        break;
      case 'buyer.receipt.confirmed':
        out.push(row('Buyer confirmed the purchase', 'signed on the receipt', 'ok'));
        break;
      case 'operator.statement':
      case 'buyer.statement':
      case 'merchant.statement':
        out.push(row(`${e.kind.split('.')[0].replace(/^\w/, (c) => c.toUpperCase())} statement`, p.flagged_instruction_like ? 'contains instruction-like text (flagged by code, ignored)' : ''));
        break;
      case 'paypal.dispute.case_opened': {
        const test = /^SELFTEST/.test(String(p.dispute_id ?? ''));
        const why = p.reason ? `: ${String(p.reason).toLowerCase().replace(/_/g, ' ')}` : '';
        out.push(test ? row('Local self-test dispute event (not from PayPal)', `${p.dispute_id}${why}`) : row('PayPal dispute opened a case', `${p.dispute_id}${why}`, 'money'));
        break;
      }
      case 'paypal.dispute.read':
        out.push(row('Dispute re-read from PayPal', [p.dispute_id, p.status && String(p.status).toLowerCase().replace(/_/g, ' ')].filter(Boolean).join(', '), 'money'));
        break;
      case 'checkout.replayed':
        out.push(row('Checkout request repeated: the first result was returned, nothing charged twice'));
        break;
      case 'case.assessed':
        out.push(row(`Assessed: ${verdictWords(p.verdict)}`, String(p.model ?? '').replace(/^\w+\//, '')));
        break;
      case 'ruling.approved':
        out.push(row(`Ruling approved: ${verdictWords(p.verdict)}`, p.approved_by?.name ? `by ${p.approved_by.name}, signed by Recourse` : '', 'ok'));
        break;
      case 'ruling.operator_accepted':
        out.push(row('Operator accepted the ruling', p.appeal_waived ? `${p.accepted_by ?? ''}, appeal waived`.replace(/^, /, '') : (p.accepted_by ?? '')));
        break;
      case 'settlement.obligation_created':
        out.push(row('Settlement due', `${String(p.kind ?? '').toLowerCase().replace(/_/g, ' ')} of ${money(p.amount)}`));
        break;
      case 'settlement.action_intended':
        out.push(row(`About to: ${actionWords(p.action).replace(/^\w/, (c) => c.toLowerCase())}`, `${money(p.amount)}, intent stored before calling PayPal`.replace(/^, /, '')));
        break;
      case 'settlement.action_result': {
        const ids = Object.entries(p.paypal_ids ?? {}).map(([k, v]) => `${PAYPAL_ID[k] ?? k} ${v}`).join(', ');
        const ok = p.status === 'SUCCEEDED';
        out.push(row(`${actionWords(p.action)}: ${ok ? 'done' : String(p.status ?? '').toLowerCase()}`, ids || p.error || '', ok ? 'money' : 'block'));
        break;
      }
      case 'settlement.recovered':
        out.push(row('Recovered, confirmed by PayPal', `${p.recovered} recovered${p.confirmed_by ? `, confirmed by ${p.confirmed_by === 'webhook' ? 'PayPal webhook' : p.confirmed_by}` : ''}`, 'ok'));
        break;
      default: {
        if (e.kind.startsWith('paypal.')) {
          const name = e.kind.replace(/^paypal\./, '').replace(/[._]/g, ' ');
          out.push(row(`PayPal: ${name}`, money(p.amount), 'money'));
        } else out.push(row(e.kind.replace(/[._]/g, ' ').replace(/^\w/, (c) => c.toUpperCase())));
      }
    }
  }
  return out;
}
