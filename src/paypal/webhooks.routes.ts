import express, { Router } from 'express';
import { openCaseFromDispute } from '../accountability/cases';
import { onCaptureCompleted, onInvoicePaid, onRefundCompleted } from '../settlement/confirm';
import { appendEntry } from '../evidence/recorder';
import { env } from '../config';
import { db } from '../shared/db/pool';
import { route } from '../shared/http/errors';
import { pp } from './http';

/**
 * POST /webhooks/paypal
 *  1. Verify the signature with PayPal (verify-webhook-signature, WEBHOOK_ID). Unverified events are
 *     rejected (401) and never stored, so nobody can pre-claim an event id.
 *  2. Dedupe by PayPal's event id in paypal_events (a repeat delivery only bumps `deliveries`).
 *  3. Process: dispute events re-read the dispute from PayPal instead of trusting the event body;
 *     events that match one of our orders (invoice_id / capture id) are appended to its recorder case.
 */
export const paypalWebhooks = Router();

type Headers = Record<string, string | string[] | undefined>;

async function verify(headers: Headers, event: unknown): Promise<string> {
  const webhookId = env('WEBHOOK_ID');
  if (!webhookId) return 'NO_WEBHOOK_ID';
  if (!headers['paypal-transmission-sig']) return 'MISSING_SIGNATURE';
  const r = await pp('POST', '/v1/notifications/verify-webhook-signature', {
    json: {
      auth_algo: headers['paypal-auth-algo'],
      cert_url: headers['paypal-cert-url'],
      transmission_id: headers['paypal-transmission-id'],
      transmission_sig: headers['paypal-transmission-sig'],
      transmission_time: headers['paypal-transmission-time'],
      webhook_id: webhookId,
      webhook_event: event,
    },
  });
  return r.status === 200 ? r.body.verification_status : `ERROR_HTTP_${r.status}`;
}

async function findOrder(invoiceId?: string | null, captureId?: string | null) {
  if (!invoiceId && !captureId) return undefined;
  const r = await db().query<{ id: string; case_ref: string; order_ref: string }>(
    'SELECT id, case_ref, order_ref FROM orders WHERE invoice_id = $1 OR paypal_capture_id = $2 LIMIT 1',
    [invoiceId ?? null, captureId ?? null],
  );
  return r.rows[0];
}

async function process(event: any) {
  const type: string = event.event_type;
  const res = event.resource ?? {};
  if (type.startsWith('CUSTOMER.DISPUTE.')) {
    const id = res.dispute_id ?? res.id;
    const fresh = await pp('GET', `/v1/customer/disputes/${id}`);
    const d = fresh.body ?? {};
    const tx = d.disputed_transactions?.[0] ?? res.disputed_transactions?.[0] ?? {};
    const order = await findOrder(tx.invoice_number, tx.seller_transaction_id);
    const result = {
      dispute_id: id,
      reread_http: fresh.status,
      reread_debug_id: fresh.debugId,
      status: d.status ?? null,
      stage: d.dispute_life_cycle_stage ?? null,
      outcome: d.dispute_outcome ?? null,
      links: (d.links ?? []).map((l: { rel: string }) => l.rel),
      event_said: { status: res.status ?? null },
      order_ref: order?.order_ref ?? null,
    };
    if (order) await appendEntry(order.case_ref, 'paypal.dispute.read', { event_id: event.id, event_type: type, ...result });
    // Workflow B: open (or find) the case for this dispute, from the re-read dispute, not the event body.
    const cs = fresh.status === 200 && type !== 'CUSTOMER.DISPUTE.RESOLVED' ? await openCaseFromDispute(d) : null;
    return { result: { ...result, case_id: cs?.id ?? null }, orderId: order?.id };
  }
  if (type === 'PAYMENT.CAPTURE.COMPLETED') {
    const obligation = await onCaptureCompleted(res.id, 'webhook');
    const order = await findOrder(res.invoice_id, res.id);
    return { result: { capture_id: res.id, status: res.status, custom_id: res.custom_id ?? null, invoice_id: res.invoice_id ?? null, settlement_obligation_confirmed: obligation }, orderId: order?.id };
  }
  if (type === 'INVOICING.INVOICE.PAID') {
    const invoiceId = res.invoice?.id ?? res.id;
    const obligation = invoiceId ? await onInvoicePaid(invoiceId, 'webhook') : null;
    return { result: { invoice_id: invoiceId, settlement_obligation_confirmed: obligation }, orderId: undefined };
  }
  if (type === 'PAYMENT.CAPTURE.REFUNDED') await onRefundCompleted(res.id, 'webhook');
  if (type === 'PAYMENT.CAPTURE.REFUNDED' || type.startsWith('PAYMENT.CAPTURE.')) {
    const captureId = res.links?.find((l: { rel: string }) => l.rel === 'up')?.href?.split('/').pop() ?? res.id;
    const order = await findOrder(res.invoice_id, captureId);
    const result = { refund_or_capture_id: res.id, status: res.status, amount: res.amount, invoice_id: res.invoice_id, custom_id: res.custom_id, order_ref: order?.order_ref ?? null };
    if (order) await appendEntry(order.case_ref, `paypal.${type.toLowerCase()}`, { event_id: event.id, ...result });
    return { result, orderId: order?.id };
  }
  return { result: { recorded_only: true, resource_id: res.id ?? null }, orderId: undefined };
}

paypalWebhooks.post(
  '/',
  express.raw({ type: '*/*', limit: '2mb' }),
  route(async (req, res) => {
    let event: any;
    try {
      event = JSON.parse(Buffer.isBuffer(req.body) ? req.body.toString('utf8') : String(req.body));
    } catch {
      return res.status(400).json({ name: 'INVALID_REQUEST', message: 'Body is not JSON.' });
    }
    const verification = await verify(req.headers, event);
    console.log(`webhook ${event.event_type} ${event.id}: ${verification}`);
    if (verification !== 'SUCCESS') return res.status(verification === 'NO_WEBHOOK_ID' ? 503 : 401).json({ name: 'NOT_VERIFIED', message: verification });

    const ins = await db().query<{ id: string; inserted: boolean; deliveries: number }>(
      `INSERT INTO paypal_events (event_id, event_type, resource_type, resource_id, verification_status, payload, transmission_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (event_id) DO UPDATE SET deliveries = paypal_events.deliveries + 1
       RETURNING id, (xmax = 0) AS inserted, deliveries`,
      [event.id, event.event_type, event.resource_type ?? null, event.resource?.id ?? event.resource?.dispute_id ?? null, verification, JSON.stringify(event), String(req.headers['paypal-transmission-id'] ?? '')],
    );
    if (!ins.rows[0].inserted) {
      console.log(`webhook ${event.id}: duplicate delivery #${ins.rows[0].deliveries}, ignored`);
      return res.json({ duplicate: true, deliveries: ins.rows[0].deliveries });
    }
    const { result, orderId } = await process(event);
    await db().query('UPDATE paypal_events SET processed_at = now(), processing_result = $2, order_id = $3 WHERE id = $1', [ins.rows[0].id, JSON.stringify(result), orderId ?? null]);
    res.json({ received: true });
  }),
);
