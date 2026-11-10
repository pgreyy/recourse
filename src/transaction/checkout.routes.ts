import { Router } from 'express';
import { z } from 'zod';
import { notFound, route } from '../shared/http/errors';
import { uuidParam } from '../shared/http/ids';
import { receiptUrl } from '../accountability/receipts';
import { db } from '../shared/db/pool';
import { cancelStepUp, checkout, completeStepUp, loadOrderByRef, orderView } from './checkout';

/**
 * POST /merchant-cart/:id/checkout { mandate_id, request_id?, agent_version_id? }
 * request_id (or a PayPal-Request-Id header) makes checkout idempotent; it defaults to cart + instructions,
 * so repeating the same checkout never charges twice.
 * 200 CAPTURED (Store Sync style, with payment_confirmation), 422 STEP_UP_REQUIRED, 502 FAILED.
 */
export const checkoutRoutes = Router();

const Body = z.object({
  mandate_id: z.string().uuid(),
  request_id: z.string().trim().min(1).max(200).optional(),
  agent_version_id: z.string().uuid().optional(),
});

checkoutRoutes.post(
  '/merchant-cart/:id/checkout',
  route(async (req, res) => {
    const body = Body.parse(req.body);
    const requestId = body.request_id ?? req.header('PayPal-Request-Id') ?? `${req.params.id}:${body.mandate_id}`;
    const r = await checkout({ cartId: req.params.id, mandateId: body.mandate_id, requestId, agentVersionId: body.agent_version_id });
    if (r.status === 'CAPTURED') {
      return res.json({ ...r, payment_confirmation: { merchant_order_number: r.order.order_ref, order_review_page: r.receipt_url } });
    }
    if (r.status === 'STEP_UP_REQUIRED') {
      return res.status(422).json({
        name: 'STEP_UP_REQUIRED',
        message: 'This purchase breaks the mandate. It can go ahead only if the buyer approves it directly at PayPal.',
        details: r.firewall.violations.map((v) => ({ field: v.rule, issue: 'MANDATE_VIOLATION', description: v.detail })),
        step_up: r.step_up,
        firewall: r.firewall,
      });
    }
    return res.status(502).json({ name: 'CHECKOUT_FAILED', message: r.error, order: r.order });
  }),
);

/** PayPal sends the buyer here after approving a step-up payment. */
checkoutRoutes.get(
  '/step-ups/:id/return',
  route(async (req, res) => {
    res.json(await completeStepUp(uuidParam(req.params.id, 'Step-up')));
  }),
);

checkoutRoutes.get(
  '/step-ups/:id/cancel',
  route(async (req, res) => {
    res.json(await cancelStepUp(uuidParam(req.params.id, 'Step-up')));
  }),
);

checkoutRoutes.get(
  '/orders/:ref',
  route(async (req, res) => {
    const o = await loadOrderByRef(req.params.ref);
    if (!o) throw notFound('Order', req.params.ref);
    const r = await db().query<{ id: string }>('SELECT id FROM receipts WHERE order_id = $1', [o.id]);
    res.json({ ...orderView(o), receipt_url: r.rows[0] ? receiptUrl(r.rows[0].id) : null });
  }),
);
