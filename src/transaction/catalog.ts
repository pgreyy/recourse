import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import { db } from '../shared/db/pool';

/** The demo merchant. Liability agreements name it as the covered merchant. */
export const DEMO_MERCHANT = { id: 'stride-and-co', name: 'Stride & Co' } as const;

const Attributes = z.object({
  size: z.string().min(1),
  unit_system: z.enum(['US', 'UK', 'EU']).nullable(), // null = the merchant left it out
  gender: z.string().nullable(),
});
const Variant = z.object({
  id: z.string(),
  attributes: Attributes,
  price: z.string().regex(/^\d+\.\d{2}$/),
  stock: z.number().int().min(0),
  description: z.string().default(''),
});
const CatalogFile = z.object({
  catalog_version: z.string().min(1),
  merchant: z.object({ id: z.string(), name: z.string(), currency: z.string().length(3) }),
  listings: z.array(
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
export type CatalogFile = z.infer<typeof CatalogFile>;

export function readCatalogFile(path = resolve(process.cwd(), 'data/catalog.json')): CatalogFile {
  return CatalogFile.parse(JSON.parse(readFileSync(path, 'utf8')));
}

/** A variant joined with its listing, as cart validation sees it. */
export type VariantView = {
  variant_id: string;
  listing_id: string;
  name: string;
  brand: string;
  size: string;
  unit_system: string | null;
  gender: string | null;
  price: string;
  currency: string;
  stock: number;
  description: string;
};

export async function loadVariants(merchantId: string = DEMO_MERCHANT.id): Promise<Map<string, VariantView>> {
  const { rows } = await db().query<VariantView>(
    `SELECT v.id AS variant_id, l.id AS listing_id, l.name, l.brand, v.size, v.unit_system, v.gender,
            v.price_value::text AS price, v.currency, v.stock, v.description
     FROM merchant_variants v JOIN merchant_listings l ON l.id = v.listing_id
     WHERE l.merchant_id = $1 ORDER BY v.id`,
    [merchantId],
  );
  return new Map(rows.map((r) => [r.variant_id, { ...r, currency: r.currency.trim() }]));
}
