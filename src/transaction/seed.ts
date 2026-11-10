// npm run seed: load data/catalog.json into the merchant tables. Safe to rerun: it upserts and
// resets every variant to the file's price, stock, attributes and description.
import { closeDb, tx } from '../shared/db/pool';
import { readCatalogFile } from './catalog';

async function main(): Promise<void> {
  const catalog = readCatalogFile();
  const m = catalog.merchant;
  const counts = await tx(async (c) => {
    await c.query(
      `INSERT INTO merchants (id, name, currency, catalog_version) VALUES ($1, $2, $3, $4)
       ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, currency = EXCLUDED.currency,
         catalog_version = EXCLUDED.catalog_version, updated_at = now()`,
      [m.id, m.name, m.currency, catalog.catalog_version],
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
    return { listings: catalog.listings.length, variants };
  });
  console.log(`Seeded ${m.name} catalog ${catalog.catalog_version}: ${counts.listings} listings, ${counts.variants} variants.`);
}

main()
  .catch((e) => {
    console.error(e.message);
    process.exitCode = 1;
  })
  .finally(() => closeDb());
