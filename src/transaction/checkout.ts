import { randomBytes } from 'node:crypto';
import type pg from 'pg';
import { createReceipt, receiptUrl } from '../accountability/receipts';
import type { MandateSpec } from '../authorization/mandate-spec';
import { merchantPolicy } from '../accountability/reputation';
import { agentCoverage } from '../authorization/coverage';
import { mandateUsage } from '../authorization/mandate-usage';
import { loadMandate } from '../authorization/mandates.routes';
import { getToken } from '../authorization/payment-tokens';
import { config } from '../config';
import { appendEntry, listEntries } from '../evidence/recorder';
import { addTracker, captureOrder, createBuyerApprovalOrder, createVaultOrder, firstCapture, getOrder } from '../paypal/orders';
import type { PPResponse } from '../paypal/types';
import { db, tx } from '../shared/db/pool';
import { HttpError } from '../shared/http/errors';
import { getCart, type CartResponse } from './cart.routes';
import { runFirewall, type FirewallLine, type FirewallResult } from './firewall';

export const ANCHOR_PREFIX = 'RCS-ANCHOR ';

export type OrderRow = {
  id: string;
  order_ref: string;
  case_ref: string;
  mandate_id: string;
  mandate_lineage_id: string;
  agent_version_id: string | null;
  cart_id: string;
  merchant_id: string;
  status: string;
  lines: unknown;
  total_value: string;
  currency: string;
  firewall: FirewallResult;
  compliance: 'COMPLIANT' | 'WARNING' | 'VIOLATION_APPROVED';
  paypal_request_id: string;
  paypal_order_id: string | null;
  paypal_capture_id: string | null;
  custom_id: string;
  invoice_id: string;
  anchor_description: string;
  anchor_seq: number;
  anchor_head_hash: string;
  anchor_verified: boolean | null;
  tracker_id: string | null;
  error: string | null;
  created_at: Date;
  captured_at: Date | null;
};

export type CheckoutResult =
  | { status: 'CAPTURED'; replayed: boolean; order: ReturnType<typeof orderView>; receipt_url: string | null; firewall: FirewallResult; anchor_check?: unknown; checkpoint?: unknown }
  | { status: 'STEP_UP_REQUIRED'; firewall: FirewallResult; step_up: { id: string; approve_url: string | undefined; order_ref: string } }
  | { status: 'FAILED'; replayed: boolean; order: ReturnType<typeof orderView>; error: string };

export function orderView(o: OrderRow) {
  return {
    id: o.id,
    order_ref: o.order_ref,
    case_ref: o.case_ref,
    status: o.status,
    compliance: o.compliance,
    mandate_id: o.mandate_id,
    agent_version_id: o.agent_version_id,
    cart_id: o.cart_id,
    lines: o.lines,
    total: { value: o.total_value, currency: o.currency.trim() },
    paypal: { request_id: o.paypal_request_id, order_id: o.paypal_order_id, capture_id: o.paypal_capture_id, custom_id: o.custom_id, invoice_id: o.invoice_id },
    anchor: { description: o.anchor_description, seq: o.anchor_seq, head_hash: o.anchor_head_hash.trim(), verified_at_paypal: o.anchor_verified },
    tracker_id: o.tracker_id,
    error: o.error,
    created_at: o.created_at,
    captured_at: o.captured_at,
  };
}

const newOrderRef = () => `RCS-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${randomBytes(3).toString('hex').toUpperCase()}`;

/**
 * Which cart lines are the merchant's suggested substitute for another variant, read from the
 * recorder (the cart's own validation_issues history), not from anything the agent says.
 */
async function substitutions(caseRef: string, cartId: string): Promise<Map<string, string>> {
  const out = new Map<string, string>(); // substitute variant -> variant it replaced
  for (const e of await listEntries(caseRef)) {
    const p = e.payload as { cart_id?: string; validation_issues?: Array<{ variant_id: string | null; suggested_substitute: { variant_id: string } | null }> };
    if (!e.kind.startsWith('merchant.cart.') || p.cart_id !== cartId) continue;
    for (const i of p.validation_issues ?? []) if (i.suggested_substitute && i.variant_id) out.set(i.suggested_substitute.variant_id, i.variant_id);
  }
  return out;
}

/** Firewall input from the cart response's own catalog snapshot (the evidence the decision used). */
function firewallLines(cart: CartResponse, subs: Map<string, string>): FirewallLine[] {
  const variants = new Map<string, { listing: CartResponse['catalog_snapshot']['listings'][number]; stay?: { hotel: string; check_in: string } }>();
  for (const l of cart.catalog_snapshot.listings) for (const v of l.variants) variants.set(v.variant_id, { listing: l, stay: v.attributes.stay });
  return cart.items.map((it) => {
    const listing = variants.get(it.variant_id)!.listing;
    const replaced = subs.get(it.variant_id);
    return {
      variant_id: it.variant_id,
      listing_id: it.item_id,
      name: it.name,
      brand: listing.brand,
      category: listing.category,
      quantity: it.quantity,
      unit_price_cents: Math.round(Number(it.price.value) * 100),
      attributes: it.attributes,
      substituted_for: replaced
        ? { variant_id: replaced, listing_id: variants.get(replaced)?.listing.listing_id ?? '', hotel: variants.get(replaced)?.stay?.hotel, check_in: variants.get(replaced)?.stay?.check_in }
        : undefined,
    };
  });
}

/** Lines as stored on the order: enough for receipts and rulings without re-reading the catalog. */
function orderLines(cart: CartResponse) {
  const byVariant = new Map<string, { listing: CartResponse['catalog_snapshot']['listings'][number]; description: string }>();
  for (const l of cart.catalog_snapshot.listings) for (const v of l.variants) byVariant.set(v.variant_id, { listing: l, description: v.description });
  return cart.items.map((it) => {
    const x = byVariant.get(it.variant_id)!;
    return {
      variant_id: it.variant_id,
      listing_id: it.item_id,
      name: it.name,
      brand: x.listing.brand,
      quantity: it.quantity,
      price: it.price.value,
      attributes: it.attributes,
      variant_description: x.description,
      listing_description: x.listing.description,
    };
  });
}

async function loadOrderByRequestId(requestId: string): Promise<OrderRow | undefined> {
  return (await db().query<OrderRow>('SELECT * FROM orders WHERE paypal_request_id = $1', [requestId])).rows[0];
}

export async function loadOrderByRef(ref: string): Promise<OrderRow | undefined> {
  return (await db().query<OrderRow>('SELECT * FROM orders WHERE order_ref = $1', [ref])).rows[0];
}

async function receiptFor(orderId: string): Promise<string | null> {
  const r = await db().query<{ id: string }>('SELECT id FROM receipts WHERE order_id = $1', [orderId]);
  return r.rows[0] ? receiptUrl(r.rows[0].id) : null;
}

/**
 * The firewall evaluation shared by checkout and dry runs: current cart (with a fresh catalog snapshot),
 * instructions, purchase history, the agent's liability coverage, then runFirewall. The result is recorded
 * as checkout.firewall (or checkout.dry_run) and its entry returned so later entries can cite its seq.
 */
async function evaluate(req: { cartId: string; mandateId: string; requestId: string; agentVersionId?: string | null }, dryRun: boolean) {
  const cart = await getCart(req.cartId); // also records the cart and a fresh catalog snapshot
  if (cart.status !== 'READY') throw new HttpError(422, 'CART_NOT_READY', `Cart is ${cart.status}; resolve its validation_issues first.`, { validation_issues: cart.validation_issues });
  const mandate = await loadMandate(req.mandateId);
  const spec = mandate.spec as MandateSpec;
  const usage = await mandateUsage(mandate.lineage_id);
  const merchantRow = (await db().query<{ id: string; name: string; delivery_days: number | null }>('SELECT id, name, delivery_days FROM merchants WHERE id = $1', [cart.merchant.id])).rows[0];
  const lines = firewallLines(cart, await substitutions(cart.case_ref, cart.id));
  const coverage = req.agentVersionId ? await agentCoverage(req.agentVersionId) : null;
  const policy = req.agentVersionId ? await merchantPolicy(req.agentVersionId) : null;
  const firewall = runFirewall({
    spec,
    mandate_status: mandate.status,
    expires_at: mandate.expires_at,
    history: usage,
    cart: { currency: cart.totals.total.currency_code, total_cents: Math.round(Number(cart.totals.total.value) * 100), lines },
    merchant: merchantRow,
    agent: coverage
      ? {
          agent_version_id: req.agentVersionId!,
          covered: coverage.covered,
          detail: coverage.covered ? `covered by ${coverage.operator_name}'s liability agreement v${coverage.agreement_version}` : coverage.reason,
          policy: policy?.policy ?? 'normal',
          policy_reason: policy?.reason ?? null,
        }
      : null,
    now: new Date(),
  });
  const firewallEntry = await appendEntry(cart.case_ref, dryRun ? 'checkout.dry_run' : 'checkout.firewall', {
    request_id: req.requestId,
    cart_id: cart.id,
    mandate_id: mandate.id,
    mandate_hash: mandate.mandate_hash?.trim() ?? null,
    agent_version_id: req.agentVersionId ?? null,
    agent_coverage: coverage,
    merchant_policy: policy,
    catalog_snapshot_sha256: cart.catalog_snapshot.sha256,
    decision: firewall.decision,
    violations: firewall.violations,
    warnings: firewall.warnings,
    checks: firewall.checks,
    ...(dryRun ? { note: 'dry run: nothing anchored, nothing charged' } : {}),
  });
  return { cart, mandate, firewall, firewallEntry };
}

/** Dry run: everything checkout would check, recorded, but nothing anchored and nothing charged. */
export async function previewCheckout(req: { cartId: string; mandateId: string; requestId: string; agentVersionId?: string | null }) {
  const { cart, firewall, firewallEntry } = await evaluate(req, true);
  return {
    status: 'DRY_RUN' as const,
    would: firewall.decision === 'BLOCK' ? 'STEP_UP_REQUIRED' : 'CAPTURE',
    cart_id: cart.id,
    lines: cart.items.map((i) => ({ variant_id: i.variant_id, name: i.name, attributes: i.attributes, price: i.price.value })),
    firewall,
    recorded_at_seq: firewallEntry.seq,
  };
}

export type CheckoutRequest = { cartId: string; mandateId: string; requestId: string; agentVersionId?: string | null };

/**
 * Checkout: firewall, anchor, PayPal (payer not present, the instructions' saved PayPal), verify, track,
 * receipt. Idempotent on requestId: a repeat returns the first result and never charges again.
 */
export async function checkout(req: CheckoutRequest): Promise<CheckoutResult> {
  const existing = await loadOrderByRequestId(req.requestId);
  if (existing) {
    await appendEntry(existing.case_ref, 'checkout.replayed', { request_id: req.requestId, order_ref: existing.order_ref, status: existing.status, note: 'same request id: returned the first result, nothing charged' });
    if (existing.status === 'CAPTURED') {
      return { status: 'CAPTURED', replayed: true, order: orderView(existing), receipt_url: await receiptFor(existing.id), firewall: existing.firewall };
    }
    const step = await db().query('SELECT id, approve_url, status FROM step_ups WHERE order_id = $1', [existing.id]);
    if (step.rows[0]?.status === 'PENDING') {
      return { status: 'STEP_UP_REQUIRED', firewall: existing.firewall, step_up: { id: step.rows[0].id, approve_url: step.rows[0].approve_url, order_ref: existing.order_ref } };
    }
    return { status: 'FAILED', replayed: true, order: orderView(existing), error: existing.error ?? existing.status };
  }

  const { cart, mandate, firewall, firewallEntry } = await evaluate(req, false);
  const orderRef = newOrderRef();
  const blocked = firewall.decision === 'BLOCK';
  const compliance = blocked ? 'VIOLATION_APPROVED' : firewall.decision === 'WARN' ? 'WARNING' : 'COMPLIANT';
  const stored = orderLines(cart);

  // Anchor: the chain head right after recording the purchase decision goes into the PayPal order.
  const decided = await appendEntry(cart.case_ref, blocked ? 'checkout.step_up_required' : 'checkout.started', {
    order_ref: orderRef,
    request_id: req.requestId,
    cart_id: cart.id,
    mandate_id: mandate.id,
    agent_version_id: req.agentVersionId ?? null,
    lines: stored,
    total: cart.totals.total,
    firewall_decision: firewall.decision,
    firewall_entry_seq: firewallEntry.seq,
    // The case can cite "warned at step N, proceeded at step N+1" (or "blocked at step N").
    ...(firewall.decision === 'WARN'
      ? { proceeded_despite_warnings: { warning_entry_seq: firewallEntry.seq, rules: firewall.warnings.map((w) => w.rule), details: firewall.warnings.map((w) => w.detail) } }
      : {}),
    ...(blocked ? { blocked_by_entry_seq: firewallEntry.seq } : {}),
    compliance,
  });
  const anchor = `${ANCHOR_PREFIX}${decided.hash}`;

  const { rows } = await db().query<OrderRow>(
    `INSERT INTO orders (order_ref, case_ref, mandate_id, mandate_lineage_id, agent_version_id, cart_id, merchant_id, lines, total_value, currency,
       firewall, compliance, paypal_request_id, custom_id, invoice_id, anchor_description, anchor_seq, anchor_head_hash)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18) RETURNING *`,
    [orderRef, cart.case_ref, mandate.id, mandate.lineage_id, req.agentVersionId ?? null, cart.id, cart.merchant.id, JSON.stringify(stored),
      cart.totals.total.value, cart.totals.total.currency_code, JSON.stringify(firewall), compliance, req.requestId,
      mandate.mandate_hash?.trim() ?? '', orderRef, anchor, decided.seq, decided.hash],
  );
  const order = rows[0];
  const paypalInput = {
    amount: cart.totals.total.value,
    currency: cart.totals.total.currency_code,
    customId: order.custom_id,
    invoiceId: order.invoice_id,
    description: anchor,
  };

  if (blocked) {
    const step = await db().query<{ id: string }>(
      `INSERT INTO step_ups (case_ref, mandate_id, cart_id, violations, order_id) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [cart.case_ref, mandate.id, cart.id, JSON.stringify(firewall.violations), order.id],
    );
    const base = config.publicBaseUrl();
    const pp = await createBuyerApprovalOrder(
      { ...paypalInput, returnUrl: `${base}/step-ups/${step.rows[0].id}/return`, cancelUrl: `${base}/step-ups/${step.rows[0].id}/cancel` },
      `${req.requestId}:step-up`,
    );
    const approve = pp.body?.links?.find((l: { rel: string }) => l.rel === 'payer-action' || l.rel === 'approve')?.href;
    await db().query('UPDATE step_ups SET paypal_order_id = $2, approve_url = $3 WHERE id = $1', [step.rows[0].id, pp.body?.id ?? null, approve ?? null]);
    await db().query('UPDATE orders SET paypal_order_id = $2 WHERE id = $1', [order.id, pp.body?.id ?? null]);
    await appendEntry(cart.case_ref, 'checkout.step_up_link', { step_up_id: step.rows[0].id, paypal_order_id: pp.body?.id, status: pp.status, debug_id: pp.debugId, approve_url: approve });
    return { status: 'STEP_UP_REQUIRED', firewall, step_up: { id: step.rows[0].id, approve_url: approve, order_ref: orderRef } };
  }

  const token = await getToken(mandate.payment_token_id);
  if (!token?.vault_id || token.status !== 'ACTIVE') return fail(order, 'the buyer instructions have no active saved payment method');
  const created = await createVaultOrder({ ...paypalInput, vaultId: token.vault_id, source: 'paypal' }, req.requestId);
  await appendEntry(order.case_ref, 'paypal.order.created', { order_ref: orderRef, http: created.status, debug_id: created.debugId, paypal_order_id: created.body?.id, status: created.body?.status, request_id: req.requestId });
  if (created.status >= 300) return fail(order, `PayPal create order HTTP ${created.status}: ${created.body?.name ?? ''} ${created.body?.message ?? ''}`.trim());
  let captured: PPResponse = created;
  if (created.body.status !== 'COMPLETED') {
    captured = await captureOrder(created.body.id, `${req.requestId}:capture`);
    await appendEntry(order.case_ref, 'paypal.order.captured', { http: captured.status, debug_id: captured.debugId, status: captured.body?.status });
    if (captured.status >= 300) return fail(order, `PayPal capture HTTP ${captured.status}`);
  }
  return finalize(order, created.body.id, captured);
}

async function fail(order: OrderRow, error: string): Promise<CheckoutResult> {
  const { rows } = await db().query<OrderRow>(`UPDATE orders SET status = 'FAILED', error = $2 WHERE id = $1 RETURNING *`, [order.id, error]);
  await appendEntry(order.case_ref, 'checkout.failed', { order_ref: order.order_ref, error });
  return { status: 'FAILED', replayed: false, order: orderView(rows[0]), error };
}

/** After capture: verify the anchor round-trip, add a tracker, settle local state, issue the receipt. */
export async function finalize(order: OrderRow, paypalOrderId: string, captured: PPResponse): Promise<CheckoutResult> {
  const capture = firstCapture(captured.body);
  if (!capture || capture.status !== 'COMPLETED') return fail(order, `capture status ${capture?.status ?? 'missing'}`);

  const read = await getOrder(paypalOrderId);
  const unit = read.body?.purchase_units?.[0] ?? {};
  const anchorCheck = {
    paypal_order_id: paypalOrderId,
    http: read.status,
    debug_id: read.debugId,
    description: { expected: order.anchor_description, returned: unit.description ?? null, match: unit.description === order.anchor_description },
    custom_id: { expected: order.custom_id, returned: unit.custom_id ?? null, match: unit.custom_id === order.custom_id },
    invoice_id: { expected: order.invoice_id, returned: unit.invoice_id ?? null, match: unit.invoice_id === order.invoice_id },
  };
  const anchorOk = anchorCheck.description.match && anchorCheck.custom_id.match && anchorCheck.invoice_id.match;
  await appendEntry(order.case_ref, 'paypal.anchor.verified', { ...anchorCheck, all_match: anchorOk });

  // Retail ships, so the capture gets a PayPal tracker. A hotel stay ships nothing: the merchant's booking
  // confirmation number is recorded instead, as evidence of what was booked.
  const stays = (order.lines as Array<{ name: string; attributes?: { stay?: { hotel: string; check_in: string; check_out: string } } }>).filter((l) => l.attributes?.stay);
  let trackerId: string | null = null;
  let bookingRef: string | null = null;
  if (stays.length) {
    bookingRef = `TWS-${order.order_ref.slice(-6).toUpperCase()}`;
    await appendEntry(order.case_ref, 'merchant.booking.confirmed', {
      merchant: 'Tidewell Stays',
      booking_ref: bookingRef,
      rate: stays[0].name,
      hotel: stays[0].attributes!.stay!.hotel,
      check_in: stays[0].attributes!.stay!.check_in,
      check_out: stays[0].attributes!.stay!.check_out,
      paypal_capture_id: capture.id,
    });
  } else {
    const tracking = `STRIDE-${order.order_ref}`;
    const tracker = await addTracker(paypalOrderId, capture.id, tracking, 'Stride & Co Demo Shipping');
    trackerId = tracker.status < 300 ? (tracker.body?.purchase_units?.[0]?.shipping?.trackers?.[0]?.id ?? tracking) : null;
    await appendEntry(order.case_ref, 'paypal.tracker.added', { http: tracker.status, debug_id: tracker.debugId, tracking_number: tracking, tracker_id: trackerId, error: tracker.status >= 300 ? tracker.body : null });
  }

  const { row, receipt, entry } = await tx(async (c: pg.PoolClient) => {
    for (const l of order.lines as Array<{ variant_id: string; quantity: number }>) {
      await c.query('UPDATE merchant_variants SET stock = GREATEST(stock - $2, 0) WHERE id = $1', [l.variant_id, l.quantity]);
    }
    await c.query(`UPDATE carts SET status = 'COMPLETED', updated_at = now() WHERE id = $1`, [order.cart_id]);
    const updated = await c.query<OrderRow>(
      `UPDATE orders SET status = 'CAPTURED', paypal_order_id = $2, paypal_capture_id = $3, anchor_verified = $4, tracker_id = $5, booking_ref = $6, captured_at = now()
       WHERE id = $1 RETURNING *`,
      [order.id, paypalOrderId, capture.id, anchorOk, trackerId, bookingRef],
    );
    const usage = await mandateUsage(order.mandate_lineage_id, c);
    const m = await c.query<{ spec: MandateSpec; status: string }>('SELECT spec, status FROM mandates WHERE id = $1', [order.mandate_id]);
    let mandateStatus = m.rows[0].status;
    if (usage.orders_placed >= m.rows[0].spec.max_orders && mandateStatus === 'ACTIVE') {
      await c.query(`UPDATE mandates SET status = 'CONSUMED', updated_at = now() WHERE id = $1`, [order.mandate_id]);
      mandateStatus = 'CONSUMED';
    }
    const receipt = await createReceipt(order.id, c);
    // This append also writes a signed checkpoint of the chain head at checkout.
    const entry = await appendEntry(
      order.case_ref,
      'checkout.completed',
      {
        order_ref: order.order_ref,
        paypal_order_id: paypalOrderId,
        paypal_capture_id: capture.id,
        amount: capture.amount,
        anchor_verified: anchorOk,
        tracker_id: trackerId,
        mandate_status: mandateStatus,
        mandate_spent: { value: (usage.spent_cents / 100).toFixed(2), orders_placed: usage.orders_placed },
        receipt_id: receipt.id,
      },
      c,
    );
    return { row: updated.rows[0], receipt, entry };
  });
  return {
    status: 'CAPTURED',
    replayed: false,
    order: orderView(row),
    receipt_url: receipt.url,
    firewall: row.firewall,
    anchor_check: { ...anchorCheck, all_match: anchorOk },
    checkpoint: { seq: entry.checkpoint.seq, head_hash: entry.checkpoint.head_hash, signed_at: entry.checkpoint.signed_at, signature: entry.checkpoint.signature },
  };
}

/** Step-up return: the buyer approved this exact payment at PayPal; capture and finish like a normal checkout. */
export async function completeStepUp(stepUpId: string): Promise<CheckoutResult> {
  const s = (await db().query('SELECT * FROM step_ups WHERE id = $1', [stepUpId])).rows[0];
  if (!s) throw new HttpError(404, 'RESOURCE_NOT_FOUND', `Step-up ${stepUpId} not found`);
  const order = (await db().query<OrderRow>('SELECT * FROM orders WHERE id = $1', [s.order_id])).rows[0];
  if (order.status === 'CAPTURED') return { status: 'CAPTURED', replayed: true, order: orderView(order), receipt_url: await receiptFor(order.id), firewall: order.firewall };
  if (s.status !== 'PENDING') throw new HttpError(409, 'STEP_UP_NOT_PENDING', `Step-up is ${s.status}.`);
  const captured = await captureOrder(s.paypal_order_id, `${order.paypal_request_id}:step-up:capture`);
  await appendEntry(order.case_ref, 'checkout.step_up_approved', { step_up_id: stepUpId, http: captured.status, debug_id: captured.debugId, status: captured.body?.status });
  if (captured.status >= 300) return fail(order, `step-up capture HTTP ${captured.status}`);
  await db().query(`UPDATE step_ups SET status = 'APPROVED', resolved_at = now() WHERE id = $1`, [stepUpId]);
  return finalize(order, s.paypal_order_id, captured);
}

export async function cancelStepUp(stepUpId: string) {
  const s = (await db().query('SELECT * FROM step_ups WHERE id = $1', [stepUpId])).rows[0];
  if (!s) throw new HttpError(404, 'RESOURCE_NOT_FOUND', `Step-up ${stepUpId} not found`);
  if (s.status === 'PENDING') {
    await db().query(`UPDATE step_ups SET status = 'CANCELLED', resolved_at = now() WHERE id = $1`, [stepUpId]);
    await db().query(`UPDATE orders SET status = 'FAILED', error = 'buyer cancelled the step-up approval' WHERE id = $1`, [s.order_id]);
    await appendEntry(s.case_ref, 'checkout.step_up_cancelled', { step_up_id: stepUpId });
  }
  return { step_up_id: stepUpId, status: s.status === 'PENDING' ? 'CANCELLED' : s.status };
}
