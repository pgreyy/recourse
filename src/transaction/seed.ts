// npm run seed: load data/catalog.json into the merchant tables. Safe to rerun: it upserts, resets every
// variant to the file's price, stock, attributes and description, and removes rows not in the file.
import { closeDb, tx } from '../shared/db/pool';
import { readCatalogFile } from './catalog';

async function main(): Promise<void> {
  const catalog = readCatalogFile();
  const m = catalog.merchant;
  const counts = await tx(async (c) => {
    await c.query(
      `INSERT INTO merchants (id, name, currency, catalog_version, delivery_days) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, currency = EXCLUDED.currency,
         catalog_version = EXCLUDED.catalog_version, delivery_days = EXCLUDED.delivery_days, updated_at = now()`,
      [m.id, m.name, m.currency, catalog.catalog_version, m.delivery_days],
    );
    let variants = 0;
    for (const l of catalog.listings) {
      await c.query(
        `INSERT INTO merchant_listings (id, merchant_id, name, brand, category, description) VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, brand = EXCLUDED.brand, category = EXCLUDED.category, description = EXCLUDED.description`,
        [l.id, m.id, l.name, l.brand, l.category, l.description],
      );
      for (const v of l.variants) {
        await c.query(
          `INSERT INTO merchant_variants (id, listing_id, size, unit_system, gender, price_value, currency, stock, description)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
           ON CONFLICT (id) DO UPDATE SET size = EXCLUDED.size, unit_system = EXCLUDED.unit_system, gender = EXCLUDED.gender,
             price_value = EXCLUDED.price_value, currency = EXCLUDED.currency, stock = EXCLUDED.stock, description = EXCLUDED.description`,
          [v.id, l.id, v.attributes.size, v.attributes.unit_system, v.attributes.gender, v.price, m.currency, v.stock, v.description],
        );
        variants++;
      }
    }
    // The file is the whole catalog: drop listings and variants that are no longer in it. Orders, carts
    // and snapshots keep their own copies of what was sold, so nothing historical points at these rows.
    const listingIds = catalog.listings.map((l) => l.id);
    const variantIds = catalog.listings.flatMap((l) => l.variants.map((v) => v.id));
    const removedVariants = await c.query(
      `DELETE FROM merchant_variants v USING merchant_listings l
       WHERE v.listing_id = l.id AND l.merchant_id = $1 AND NOT (v.id = ANY($2::text[]))`,
      [m.id, variantIds],
    );
    const removedListings = await c.query('DELETE FROM merchant_listings WHERE merchant_id = $1 AND NOT (id = ANY($2::text[]))', [m.id, listingIds]);
    return { listings: catalog.listings.length, variants, removed: (removedListings.rowCount ?? 0) + (removedVariants.rowCount ?? 0) };
  });
  console.log(`Seeded ${m.name} catalog ${catalog.catalog_version}: ${counts.listings} listings, ${counts.variants} variants; removed ${counts.removed} rows no longer in the file.`);
}

main()
  .catch((e) => {
    console.error(e.message);
    process.exitCode = 1;
  })
  .finally(() => closeDb());
