import { randomBytes } from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import { config } from '../config';
import { appendEntry } from '../evidence/recorder';
import { takeSnapshot } from '../evidence/snapshots';
import { db, tx } from '../shared/db/pool';
import { HttpError, route } from '../shared/http/errors';
import { computeCart, type CartState } from './cart';
import { DEMO_MERCHANT, loadVariants } from './catalog';

/**
 * Demo merchant "Stride & Co", with endpoints shaped like PayPal Store Sync's merchant Cart API:
 * POST /merchant-cart (201), PUT /merchant-cart/:id (200), POST /merchant-cart/:id/checkout.
 * Business problems are validation_issues on a 2xx cart, never 4xx. Every cart response carries a
 * catalog snapshot (stored in catalog_snapshots) whose sha256 is written into the flight recorder
 * under the cart's case_ref.
 */
export const merchantCart = Router();

const CaseRef = z.string().trim().min(1).max(100).regex(/^[A-Za-z0-9._:-]+$/);
const CartBody = z
  .object({
    items: z.array(z.object({ variant_id: z.string().trim().min(1), quantity: z.number().int().min(1).max(20) }).passthrough()),
    case_ref: CaseRef.optional(),
    customer: z.record(z.string(), z.unknown()).optional(),
    shipping_address: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();

type CartRow = {
  id: string;
  merchant_id: string;
  case_ref: string;
  status: string;
  items: Array<{ variant_id: string; quantity: number }>;
  customer: unknown;
  shipping_address: unknown;
  created_at: Date;
  updated_at: Date;
};

async function load(id: string): Promise<CartRow> {
  const { rows } = await db().query<CartRow>('SELECT * FROM carts WHERE id = $1', [id]);
  if (!rows[0]) throw new HttpError(404, 'CART_NOT_FOUND', `Cart ${id} not found`);
  return rows[0];
}

async function merchant(id: string) {
  const { rows } = await db().query<{ name: string; currency: string }>('SELECT name, currency FROM merchants WHERE id = $1', [id]);
  if (!rows[0]) throw new HttpError(503, 'NOT_SEEDED', 'Demo merchant is not in the database. Run npm run seed.');
  return { id, name: rows[0].name, currency: rows[0].currency.trim() };
}

/** Compact record of a cart state for the recorder (the full snapshot is referenced by hash). */
function recordPayload(cart: CartRow, state: CartState, snap: { id: string; sha256: string; catalog_version: string }) {
  return {
    cart_id: cart.id,
    merchant_id: cart.merchant_id,
    requested_items: cart.items,
    status: state.status,
    totals: state.totals,
    lines: state.items.map((l) => ({ variant_id: l.variant_id, quantity: l.quantity, price: l.price.value, attributes: l.attributes, available: l.available })),
    validation_issues: state.validation_issues.map((i) => ({
      code: i.code,
      specific_issue: (i.context as { specific_issue?: string } | undefined)?.specific_issue ?? null,
      message: i.message,
      variant_id: (i.context as { variant_id?: string } | undefined)?.variant_id ?? null,
      suggested_substitute: i.suggested_substitute ? { variant_id: i.suggested_substitute.variant_id, description: i.suggested_substitute.description, attributes: i.suggested_substitute.attributes } : null,
    })),
    catalog_snapshot: { id: snap.id, sha256: snap.sha256, catalog_version: snap.catalog_version },
  };
}

/** Validate the cart against the live catalog, snapshot the catalog, record both, and build the response. */
async function respond(cart: CartRow, kind: string) {
  const m = await merchant(cart.merchant_id);
  const state = computeCart(cart.items, await loadVariants(cart.merchant_id), m.currency);
  const { snap, entry } = await tx(async (c) => {
    const snap = await takeSnapshot(cart.merchant_id, c);
    await c.query('UPDATE carts SET status = $2, last_snapshot_id = $3 WHERE id = $1', [cart.id, state.status, snap.id]);
    const entry = await appendEntry(cart.case_ref, kind, recordPayload(cart, state, snap), c);
    return { snap, entry };
  });
  const base = `${config.publicBaseUrl()}/merchant-cart/${cart.id}`;
  return {
    id: cart.id,
    case_ref: cart.case_ref,
    merchant: { id: m.id, name: m.name },
    ...state,
    customer: cart.customer ?? undefined,
    shipping_address: cart.shipping_address ?? undefined,
    catalog_snapshot: {
      id: snap.id,
      sha256: snap.sha256,
      catalog_version: snap.catalog_version,
      taken_at: snap.taken_at,
      listings: snap.snapshot.listings,
    },
    recorder: { case_ref: entry.case_ref, seq: entry.seq, kind: entry.kind, hash: entry.hash },
    created_at: cart.created_at,
    updated_at: cart.updated_at,
    links: [
      { rel: 'self', href: base, method: 'GET' },
      { rel: 'update', href: base, method: 'PUT' },
      { rel: 'checkout', href: `${base}/checkout`, method: 'POST' },
      { rel: 'recorder', href: `${config.publicBaseUrl()}/recorder/${cart.case_ref}/verify`, method: 'GET' },
    ],
  };
}

/** POST /merchant-cart { items, case_ref? }: case_ref defaults to the cart id. */
merchantCart.post(
  '/',
  route(async (req, res) => {
    const body = CartBody.parse(req.body);
    await merchant(DEMO_MERCHANT.id);
    const id = `CART-${randomBytes(8).toString('hex').toUpperCase()}`;
    const items = body.items.map((i) => ({ variant_id: i.variant_id, quantity: i.quantity }));
    const { rows } = await db().query<CartRow>(
      `INSERT INTO carts (id, merchant_id, case_ref, items, customer, shipping_address) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [
        id,
        DEMO_MERCHANT.id,
        body.case_ref ?? id,
        JSON.stringify(items),
        body.customer ? JSON.stringify(body.customer) : null,
        body.shipping_address ? JSON.stringify(body.shipping_address) : null,
      ],
    );
    res.status(201).json(await respond(rows[0], 'merchant.cart.created'));
  }),
);

merchantCart.get(
  '/:id',
  route(async (req, res) => {
    res.json(await respond(await load(req.params.id), 'merchant.cart.viewed'));
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
      `UPDATE carts SET items = $2, customer = COALESCE($3, customer), shipping_address = COALESCE($4, shipping_address), updated_at = now()
       WHERE id = $1 RETURNING *`,
      [current.id, JSON.stringify(items), body.customer ? JSON.stringify(body.customer) : null, body.shipping_address ? JSON.stringify(body.shipping_address) : null],
    );
    res.json(await respond(rows[0], 'merchant.cart.updated'));
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
