import { checkMandateSignature } from '../authorization/mandate-document';
import { verifyChain } from '../evidence/recorder';
import { canonicalHash } from '../shared/crypto/canonical';
import { checkDocument } from '../shared/crypto/signing';
import { runFirewall, type FirewallLine } from '../transaction/firewall';
import type { CaseMaterial } from './material';

/**
 * Deterministic checks on a case (source: "code"). Any FAIL means the evidence can't be trusted as is:
 * the verdict becomes INCONCLUSIVE with human review, and no model is asked.
 */
export type CodeCheck = { id: string; status: 'PASS' | 'FAIL' | 'NOT_APPLICABLE'; detail: string; source: 'code' };
const ok = (id: string, pass: boolean, passText: string, failText: string): CodeCheck => ({ id, status: pass ? 'PASS' : 'FAIL', detail: pass ? passText : failText, source: 'code' });
const na = (id: string, detail: string): CodeCheck => ({ id, status: 'NOT_APPLICABLE', detail, source: 'code' });

export function codeChecks(m: CaseMaterial): CodeCheck[] {
  const out: CodeCheck[] = [];
  const o = m.order;
  const mandateHash = m.mandate.mandate_hash?.trim() ?? '';
  const sig = checkMandateSignature(m.mandate);
  out.push(ok('mandate.signature', sig.signature_valid, `mandate v${m.mandate.version} signature valid (${m.mandate.signing_key_id})`, `mandate signature check failed: ${sig.signature_check.reason}`));
  out.push(ok('order.custom_id', o.custom_id === mandateHash, 'order custom_id equals the mandate_hash', 'order custom_id differs from the mandate_hash'));

  const pp = m.paypal.order;
  if (!pp) {
    out.push(ok('paypal.order', false, '', `PayPal order could not be read: ${m.paypal.read_error ?? 'no PayPal order id'}`));
  } else {
    out.push(ok('paypal.custom_id', pp.custom_id === mandateHash, 'PayPal custom_id equals the mandate_hash', `PayPal custom_id is ${pp.custom_id}, mandate_hash is ${mandateHash}`));
    out.push(ok('paypal.invoice_id', pp.invoice_id === o.order_ref, `PayPal invoice_id equals order ref ${o.order_ref}`, `PayPal invoice_id is ${pp.invoice_id}, order ref is ${o.order_ref}`));
    const cap = pp.capture;
    const amountOk = !!cap && cap.status === 'COMPLETED' && cap.amount.value === o.total_value && cap.amount.currency_code === o.currency;
    out.push(ok('amount', amountOk, `captured ${o.total_value} ${o.currency} at PayPal (${cap?.id})`, `PayPal capture ${cap?.status ?? 'missing'} ${cap?.amount?.value ?? '?'} ${cap?.amount?.currency_code ?? '?'} vs order ${o.total_value} ${o.currency}`));
  }
  const linesCents = o.lines.reduce((n, l) => n + Math.round(Number(l.price) * 100) * l.quantity, 0);
  out.push(ok('order.lines_total', linesCents === Math.round(Number(o.total_value) * 100), 'order lines add up to the total', `lines add up to ${(linesCents / 100).toFixed(2)}, total is ${o.total_value}`));

  const chain = verifyChain(m.case.case_ref, m.recorder.entries, m.recorder.checkpoints);
  const entryProblems = chain.problems.filter((p) => ['DELETED', 'REORDERED', 'BROKEN_LINK', 'MODIFIED'].includes(p.reason));
  out.push(ok('recorder.chain', entryProblems.length === 0, `${chain.entries} entries, hash chain intact`, `chain problem at seq ${entryProblems[0]?.seq}: ${entryProblems[0]?.reason} (${entryProblems[0]?.detail})`));
  out.push(
    ok(
      'recorder.checkpoints',
      chain.checkpoints.all_signatures_valid && chain.checkpoints.consistent_with_chain && !chain.problems.some((p) => p.reason === 'MISSING_AT_END'),
      `${chain.checkpoints.count} signed checkpoints, all valid and consistent`,
      `checkpoints: ${chain.checkpoints.signatures_valid}/${chain.checkpoints.count} signatures valid, consistent with chain: ${chain.checkpoints.consistent_with_chain}`,
    ),
  );

  const anchorEntry = m.recorder.entries.find((e) => e.seq === o.anchor_seq);
  const anchorText = anchorEntry ? `RCS-ANCHOR ${anchorEntry.hash}` : null;
  out.push(
    ok(
      'paypal.anchor',
      !!anchorEntry && anchorEntry.kind === 'checkout.started' && anchorEntry.hash === o.anchor_head_hash && pp?.description === anchorText,
      `PayPal order description is RCS-ANCHOR + the recorded head at seq ${o.anchor_seq}`,
      `anchor mismatch: PayPal has "${pp?.description ?? '?'}", recorder head at seq ${o.anchor_seq} is ${anchorEntry?.hash ?? 'missing'}`,
    ),
  );

  const fw = [...m.recorder.entries].reverse().find((e) => e.kind === 'checkout.firewall' && e.seq < o.anchor_seq);
  const recordedSha = (fw?.payload as { catalog_snapshot_sha256?: string } | undefined)?.catalog_snapshot_sha256;
  if (!m.snapshot) out.push(ok('snapshot.hash', false, '', `catalog snapshot ${recordedSha ?? '(none recorded)'} not found`));
  else {
    const recomputed = canonicalHash(m.snapshot.snapshot);
    out.push(ok('snapshot.hash', recomputed === m.snapshot.sha256_stored && recomputed === recordedSha, `snapshot used at the decision re-hashes to ${recomputed.slice(0, 12)}…, as recorded`, `snapshot hash mismatch: recorded ${recordedSha}, stored ${m.snapshot.sha256_stored}, recomputed ${recomputed}`));
  }

  const tracker = m.recorder.entries.find((e) => e.kind === 'paypal.tracker.added');
  out.push(ok('tracking', !!o.tracker_id && (tracker?.payload as { http?: number } | undefined)?.http! < 300, `tracking ${o.tracker_id}`, 'no shipment tracker on the capture'));

  const ack = m.recorder.entries.find((e) => e.kind === 'buyer.receipt.confirmed');
  if (!ack) out.push(na('receipt.acknowledgement', m.receipt ? `receipt ${m.receipt.status}; no acknowledgement` : 'no receipt'));
  else {
    const { acknowledgement_hash, signature, ...doc } = ack.payload as Record<string, string>;
    const check = checkDocument(doc, { hash: acknowledgement_hash, signature, keyId: doc.signing_key_id });
    out.push(ok('receipt.acknowledgement', check.valid && (!m.receipt?.acknowledgement_hash || m.receipt.acknowledgement_hash === acknowledgement_hash), `buyer's signed confirmation verifies (seq ${ack.seq})`, `buyer confirmation does not verify: ${check.reason}`));
  }
  return out;
}

export const evidenceTampered = (checks: CodeCheck[]) => checks.some((c) => c.status === 'FAIL');

export type Alternative = { variant_id: string; listing_id: string; name: string; brand: string; attributes: FirewallLine['attributes']; price: string; stock: number };

/**
 * Counterfactual (source: "code"): from the frozen snapshot used at the decision step, every in-stock
 * variant that passes every mandate clause with no warning. If one exists, a compliant alternative existed.
 */
export function counterfactual(m: CaseMaterial): { source: 'code'; snapshot_sha256: string | null; compliant_alternatives: Alternative[]; note: string } {
  if (!m.snapshot) return { source: 'code', snapshot_sha256: null, compliant_alternatives: [], note: 'no decision snapshot available' };
  const fw = [...m.recorder.entries].reverse().find((e) => e.kind === 'checkout.firewall' && e.seq < m.order.anchor_seq);
  const at = fw?.created_at ?? m.order.captured_at ?? new Date();
  const alternatives: Alternative[] = [];
  for (const l of m.snapshot.snapshot.listings) {
    for (const v of l.variants) {
      if (v.stock <= 0) continue;
      const line: FirewallLine = {
        variant_id: v.variant_id,
        listing_id: l.listing_id,
        name: l.name,
        brand: l.brand,
        category: l.category,
        quantity: m.mandate.spec.quantity,
        unit_price_cents: Math.round(Number(v.price.value) * 100),
        attributes: v.attributes,
      };
      const r = runFirewall({
        spec: m.mandate.spec,
        mandate_status: 'ACTIVE',
        expires_at: m.mandate.expires_at,
        history: { spent_cents: m.order.spent_before_cents, orders_placed: 0, units_bought: 0 },
        cart: { currency: v.price.currency_code, total_cents: line.unit_price_cents * line.quantity, lines: [line] },
        merchant: m.snapshot.snapshot.merchant,
        agent: null,
        now: at,
      });
      if (r.decision === 'PASS') alternatives.push({ variant_id: v.variant_id, listing_id: l.listing_id, name: l.name, brand: l.brand, attributes: v.attributes, price: v.price.value, stock: v.stock });
    }
  }
  alternatives.sort((a, b) => Number(a.price) - Number(b.price));
  return {
    source: 'code',
    snapshot_sha256: m.snapshot.sha256_stored,
    compliant_alternatives: alternatives,
    note: alternatives.length
      ? `${alternatives.length} in-stock listing(s) satisfied every mandate clause at the decision step, e.g. ${alternatives[0].name} ${alternatives[0].attributes.unit_system ?? ''} ${alternatives[0].attributes.size} at ${alternatives[0].price}`
      : 'no in-stock listing satisfied every mandate clause at the decision step',
  };
}

/** Facts about the decision, read from the recorder (source: "code"). */
export function decisionFacts(m: CaseMaterial) {
  const E = m.recorder.entries;
  const facts: Array<{ fact: string; seqs: number[]; source: 'code' }> = [];
  const started = E.find((e) => e.kind === 'checkout.started' && e.seq === m.order.anchor_seq) ?? E.find((e) => e.kind === 'checkout.started');
  const pdw = (started?.payload as { proceeded_despite_warnings?: { warning_entry_seq: number; details: string[] } } | undefined)?.proceeded_despite_warnings;
  if (started && pdw) {
    facts.push({ fact: `firewall warned at step ${pdw.warning_entry_seq} (${pdw.details.join('; ')}), and the purchase proceeded at step ${started.seq}`, seqs: [pdw.warning_entry_seq, started.seq], source: 'code' });
  }
  const suggested = new Map<string, { seq: number; from: string }>();
  for (const e of E) {
    const p = e.payload as { validation_issues?: Array<{ variant_id: string | null; suggested_substitute: { variant_id: string } | null }> };
    if (e.kind.startsWith('merchant.cart.')) for (const i of p.validation_issues ?? []) if (i.suggested_substitute) suggested.set(i.suggested_substitute.variant_id, { seq: e.seq, from: i.variant_id ?? '?' });
    if (e.kind === 'agent.tool_call') {
      const tc = e.payload as { tool: string; input?: { items?: Array<{ variant_id: string }> } };
      for (const it of tc.input?.items ?? []) {
        const s = suggested.get(it.variant_id);
        if (s && tc.tool === 'update_cart') facts.push({ fact: `the merchant's cart response at step ${s.seq} suggested ${it.variant_id} in place of ${s.from}; the agent switched to it with update_cart (recorded at step ${e.seq})`, seqs: [s.seq, e.seq], source: 'code' });
      }
    }
  }
  const firstCart = E.find((e) => e.kind === 'agent.tool_call' && (e.payload as { tool: string }).tool === 'create_cart');
  if (firstCart) {
    const created = E.find((e) => e.kind === 'merchant.cart.created' && e.seq < firstCart.seq);
    const items = ((firstCart.payload as { input?: { items?: Array<{ variant_id: string }> } }).input?.items ?? []).map((i) => i.variant_id).join(', ');
    facts.push({ fact: `the agent first asked for ${items} (cart created at step ${created?.seq ?? '?'}, call recorded at step ${firstCart.seq})`, seqs: [created?.seq ?? firstCart.seq, firstCart.seq], source: 'code' });
  }
  return facts.sort((a, b) => a.seqs[0] - b.seqs[0]);
}
