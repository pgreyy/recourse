import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import { db } from '../db/pool';

export const MERCHANT_ID = 'stride-and-co';

const Variant = z.object({
  id: z.string(),
  size_system: z.enum(['US', 'UK', 'EU']),
  size: z.string(),
  price: z.string().regex(/^\d+\.\d{2}$/),
  stock: z.number().int().min(0),
});
const Catalog = z.object({
  merchant: z.object({ id: z.string(), name: z.string(), currency: z.string().length(3) }),
  products: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      brand: z.string(),
      category: z.string(),
      description: z.string().default(''),
      variants: z.array(Variant).min(1),
    }),
  ),
});
export type Catalog = z.infer<typeof Catalog>;

export function readCatalogFile(path = resolve(process.cwd(), 'data/catalog.json')): Catalog {
  return Catalog.parse(JSON.parse(readFileSync(path, 'utf8')));
}

/** A variant joined with its product, as the cart logic sees it. */
export type VariantView = {
  variant_id: string;
  product_id: string;
  name: string;
  brand: string;
  category: string;
  size_system: string;
  size: string;
  price: string;
  currency: string;
  stock: number;
};

export async function loadVariants(merchantId = MERCHANT_ID): Promise<Map<string, VariantView>> {
  const { rows } = await db().query<VariantView>(
    `SELECT v.id AS variant_id, p.id AS product_id, p.name, p.brand, p.category,
            v.size_system, v.size, v.price_value::text AS price, v.currency, v.stock
     FROM merchant_variants v JOIN merchant_products p ON p.id = v.product_id
     WHERE p.merchant_id = $1`,
    [merchantId],
  );
  return new Map(rows.map((r) => [r.variant_id, { ...r, currency: r.currency.trim() }]));
}
