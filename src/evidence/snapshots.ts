import type pg from 'pg';
import { canonicalHash } from '../shared/crypto/canonical';
import { db } from '../shared/db/pool';

/**
 * A catalog snapshot is everything the merchant showed at a moment: every listing and variant with
 * structured attributes, descriptions, prices, stock and catalog_version. sha256 is over the
 * canonical JSON of the snapshot body, so the same catalog state always has the same hash and is
 * stored once (catalog_snapshots.sha256 is unique).
 */
export type Snapshot = {
  merchant: { id: string; name: string; delivery_days: number | null };
  catalog_version: string;
  currency: string;
  listings: Array<{
    listing_id: string;
    name: string;
    brand: string;
    category: string;
    description: string;
    variants: Array<{
      variant_id: string;
      attributes: { size: string; unit_system: string | null; gender: string | null };
      price: { currency_code: string; value: string };
      stock: number;
      description: string;
    }>;
  }>;
};

export async function buildSnapshot(merchantId: string, c: pg.Pool | pg.PoolClient = db()): Promise<Snapshot> {
  const m = await c.query<{ id: string; name: string; currency: string; catalog_version: string; delivery_days: number | null }>(
    'SELECT id, name, currency, catalog_version, delivery_days FROM merchants WHERE id = $1',
    [merchantId],
  );
  if (!m.rows[0]) throw new Error(`merchant ${merchantId} is not seeded`);
  const listings = await c.query('SELECT id, name, brand, category, description FROM merchant_listings WHERE merchant_id = $1 ORDER BY id', [merchantId]);
  const variants = await c.query(
    `SELECT v.id, v.listing_id, v.size, v.unit_system, v.gender, v.price_value::text AS price, v.currency, v.stock, v.description
     FROM merchant_variants v JOIN merchant_listings l ON l.id = v.listing_id WHERE l.merchant_id = $1 ORDER BY v.id`,
    [merchantId],
  );
  return {
    merchant: { id: m.rows[0].id, name: m.rows[0].name, delivery_days: m.rows[0].delivery_days },
    catalog_version: m.rows[0].catalog_version,
    currency: m.rows[0].currency.trim(),
    listings: listings.rows.map((l) => ({
      listing_id: l.id,
      name: l.name,
      brand: l.brand,
      category: l.category,
      description: l.description,
      variants: variants.rows
        .filter((v) => v.listing_id === l.id)
        .map((v) => ({
          variant_id: v.id,
          attributes: { size: v.size, unit_system: v.unit_system, gender: v.gender },
          price: { currency_code: v.currency.trim(), value: v.price },
          stock: v.stock,
          description: v.description,
        })),
    })),
  };
}

export type StoredSnapshot = { id: string; sha256: string; catalog_version: string; taken_at: string; snapshot: Snapshot };

/** Build, hash and store (once per distinct sha256) the merchant's current catalog. */
export async function takeSnapshot(merchantId: string, c: pg.Pool | pg.PoolClient = db()): Promise<StoredSnapshot> {
  const snapshot = await buildSnapshot(merchantId, c);
  const sha256 = canonicalHash(snapshot);
  const { rows } = await c.query<{ id: string }>(
    `INSERT INTO catalog_snapshots (merchant_id, catalog_version, sha256, snapshot) VALUES ($1, $2, $3, $4)
     ON CONFLICT (sha256) DO UPDATE SET sha256 = EXCLUDED.sha256 RETURNING id`,
    [merchantId, snapshot.catalog_version, sha256, JSON.stringify(snapshot)],
  );
  return { id: rows[0].id, sha256, catalog_version: snapshot.catalog_version, taken_at: new Date().toISOString(), snapshot };
}

/** Re-hash a stored snapshot to show it has not changed since it was recorded. */
export async function checkSnapshot(id: string): Promise<{ id: string; sha256: string; recomputed: string; valid: boolean } | undefined> {
  const { rows } = await db().query<{ id: string; sha256: string; snapshot: Snapshot }>('SELECT id, sha256, snapshot FROM catalog_snapshots WHERE id = $1', [id]);
  if (!rows[0]) return undefined;
  const recomputed = canonicalHash(rows[0].snapshot);
  return { id, sha256: rows[0].sha256.trim(), recomputed, valid: recomputed === rows[0].sha256.trim() };
}
