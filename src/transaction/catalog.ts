import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import { db } from '../shared/db/pool';

/** The retail demo merchant (the archived shoe scenarios and the retail scorecard cases). */
export const DEMO_MERCHANT = { id: 'stride-and-co', name: 'Stride & Co' } as const;
/** The travel demo merchant: a fictional hotel booking site, the main demo. */
export const TRAVEL_MERCHANT = { id: 'tidewell-stays', name: 'Tidewell Stays' } as const;
export const MERCHANT_NAMES: Record<string, string> = { [DEMO_MERCHANT.id]: DEMO_MERCHANT.name, [TRAVEL_MERCHANT.id]: TRAVEL_MERCHANT.name };
export const CATALOG_FILES = ['data/catalog.json', 'data/catalog-tidewell.json'];

/** A hotel rate's structured data as the merchant supplies it. refund_policy null = the merchant left it out. */
export const Stay = z.object({
  hotel: z.string().min(1),
  stars: z.number().int().min(1).max(5).nullable(),
  city: z.string().min(1),
  check_in: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  check_out: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  nights: z.number().int().min(1),
  refund_policy: z.enum(['REFUNDABLE', 'NON_REFUNDABLE']).nullable(),
});
export type Stay = z.infer<typeof Stay>;
/** A line's structured attributes: a size for retail, a stay for travel. Null where the merchant gave none. */
export type LineAttrs = { size: string | null; unit_system: string | null; gender: string | null; stay?: Stay };

const Attributes = z.object({
  size: z.string().min(1).nullable().default(null),
  unit_system: z.enum(['US', 'UK', 'EU']).nullable().default(null), // null = the merchant left it out
  gender: z.string().nullable().default(null),
});
const Variant = z.object({
  id: z.string(),
  attributes: Attributes.default({ size: null, unit_system: null, gender: null }),
  stay: Stay.optional(),
  price: z.string().regex(/^\d+\.\d{2}$/),
  stock: z.number().int().min(0),
  description: z.string().default(''),
});
const CatalogFile = z.object({
  catalog_version: z.string().min(1),
  merchant: z.object({ id: z.string(), name: z.string(), currency: z.string().length(3), delivery_days: z.number().int().min(0).nullable(), domain: z.enum(['retail', 'travel']).default('retail') }),
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
  category: string;
  size: string | null;
  unit_system: string | null;
  gender: string | null;
  price: string;
  currency: string;
  stock: number;
  description: string;
  stay: Stay | null;
};

export async function loadVariants(merchantId: string = DEMO_MERCHANT.id): Promise<Map<string, VariantView>> {
  const { rows } = await db().query<VariantView>(
    `SELECT v.id AS variant_id, l.id AS listing_id, l.name, l.brand, l.category, v.size, v.unit_system, v.gender,
            v.price_value::text AS price, v.currency, v.stock, v.description, v.stay
     FROM merchant_variants v JOIN merchant_listings l ON l.id = v.listing_id
     WHERE l.merchant_id = $1 ORDER BY v.id`,
    [merchantId],
  );
  return new Map(rows.map((r) => [r.variant_id, { ...r, currency: r.currency.trim() }]));
}
