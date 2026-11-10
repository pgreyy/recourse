// npm run seed: load data/catalog.json into the merchant tables. Safe to rerun: it upserts,
// and resets every variant's price and stock to the file's values.
import { closeDb, tx } from '../db/pool';
import { readCatalogFile } from './catalog';

async function main(): Promise<void> {
  const catalog = readCatalogFile();
  const counts = await tx(async (c) => {
    const m = catalog.merchant;
    await c.query(
      `INSERT INTO merchants (id, name, currency) VALUES ($1, $2, $3)
       ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, currency = EXCLUDED.currency`,
      [m.id, m.name, m.currency],
    );
    let variants = 0;
    for (const p of catalog.products) {
      await c.query(
        `INSERT INTO merchant_products (id, merchant_id, name, brand, category, description) VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, brand = EXCLUDED.brand, category = EXCLUDED.category, description = EXCLUDED.description`,
        [p.id, m.id, p.name, p.brand, p.category, p.description],
      );
      for (const v of p.variants) {
        await c.query(
          `INSERT INTO merchant_variants (id, product_id, size_system, size, price_value, currency, stock) VALUES ($1, $2, $3, $4, $5, $6, $7)
           ON CONFLICT (id) DO UPDATE SET size_system = EXCLUDED.size_system, size = EXCLUDED.size,
             price_value = EXCLUDED.price_value, currency = EXCLUDED.currency, stock = EXCLUDED.stock`,
          [v.id, p.id, v.size_system, v.size, v.price, m.currency, v.stock],
        );
        variants++;
      }
    }
    return { products: catalog.products.length, variants };
  });
  console.log(`Seeded ${catalog.merchant.name}: ${counts.products} products, ${counts.variants} variants.`);
}

main()
  .catch((e) => {
    console.error(e.message);
    process.exitCode = 1;
  })
  .finally(() => closeDb());
