import { randomBytes } from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import { config } from '../config';
import { db } from '../db/pool';
import { HttpError, route } from '../http/errors';
import { computeCart } from './cart';
import { loadVariants, MERCHANT_ID } from './catalog';

/**
 * Demo merchant "Stride & Co", with endpoints shaped like PayPal Store Sync's merchant Cart API:
 * POST /merchant-cart (201), PUT /merchant-cart/:id (200), POST /merchant-cart/:id/checkout.
 * Business problems come back as validation_issues on a 2xx cart, never as 4xx.
 */
export const merchantCart = Router();

const CartBody = z
  .object({
    items: z.array(
      z
        .object({
          variant_id: z.string().trim().min(1),
          quantity: z.number().int().min(1).max(20),
        })
        .passthrough(),
    ),
    customer: z.record(z.string(), z.unknown()).optional(),
    shipping_address: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();

type CartRow = {
  id: string;
  merchant_id: string;
  status: string;
  items: Array<{ variant_id: string; quantity: number }>;
  customer: unknown;
  shipping_address: unknown;
  created_at: Date;
  updated_at: Date;
};

async function respond(row: CartRow) {
  const merchant = await db().query<{ name: string; currency: string }>('SELECT name, currency FROM merchants WHERE id = $1', [row.merchant_id]);
  if (!merchant.rows[0]) throw new HttpError(503, 'NOT_SEEDED', 'Demo merchant is not in the database. Run npm run seed.');
  const state = computeCart(row.items, await loadVariants(row.merchant_id), merchant.rows[0].currency.trim());
  if (state.status !== row.status) {
    await db().query('UPDATE merchant_carts SET status = $2 WHERE id = $1', [row.id, state.status]);
  }
  const base = `${config.publicBaseUrl()}/merchant-cart/${row.id}`;
  return {
    id: row.id,
    merchant: { id: row.merchant_id, name: merchant.rows[0].name },
    ...state,
    customer: row.customer ?? undefined,
    shipping_address: row.shipping_address ?? undefined,
    created_at: row.created_at,
    updated_at: row.updated_at,
    links: [
      { rel: 'self', href: base, method: 'GET' },
      { rel: 'update', href: base, method: 'PUT' },
      { rel: 'checkout', href: `${base}/checkout`, method: 'POST' },
    ],
  };
}

async function load(id: string): Promise<CartRow> {
  const { rows } = await db().query<CartRow>('SELECT * FROM merchant_carts WHERE id = $1', [id]);
  if (!rows[0]) throw new HttpError(404, 'CART_NOT_FOUND', `Cart ${id} not found`);
  return rows[0];
}

merchantCart.post(
  '/',
  route(async (req, res) => {
    const body = CartBody.parse(req.body);
    const id = `CART-${randomBytes(8).toString('hex').toUpperCase()}`;
    const items = body.items.map((i) => ({ variant_id: i.variant_id, quantity: i.quantity }));
    const { rows } = await db().query<CartRow>(
      `INSERT INTO merchant_carts (id, merchant_id, items, customer, shipping_address)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [id, MERCHANT_ID, JSON.stringify(items), body.customer ? JSON.stringify(body.customer) : null, body.shipping_address ? JSON.stringify(body.shipping_address) : null],
    );
    res.status(201).json(await respond(rows[0]));
  }),
);

merchantCart.get(
  '/:id',
  route(async (req, res) => {
    res.json(await respond(await load(req.params.id)));
  }),
);

/** PUT replaces the writable fields (items, customer, shipping_address), as the Cart API does. */
merchantCart.put(
  '/:id',
  route(async (req, res) => {
    const current = await load(req.params.id);
    if (current.status === 'COMPLETED') throw new HttpError(422, 'CART_COMPLETED', 'Cart is already checked out.');
    const body = CartBody.parse(req.body);
    const items = body.items.map((i) => ({ variant_id: i.variant_id, quantity: i.quantity }));
    const { rows } = await db().query<CartRow>(
      `UPDATE merchant_carts SET items = $2, customer = COALESCE($3, customer), shipping_address = COALESCE($4, shipping_address), updated_at = now()
       WHERE id = $1 RETURNING *`,
      [current.id, JSON.stringify(items), body.customer ? JSON.stringify(body.customer) : null, body.shipping_address ? JSON.stringify(body.shipping_address) : null],
    );
    res.json(await respond(rows[0]));
  }),
);

/** Phase 3 wires this to PayPal. */
merchantCart.post(
  '/:id/checkout',
  route(async (req, res) => {
    await load(req.params.id);
    res.status(501).json({ name: 'NOT_IMPLEMENTED', message: 'Checkout is not wired to PayPal yet (Phase 3).' });
  }),
);
