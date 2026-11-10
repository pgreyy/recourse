// npm run migrate: apply migrations/*.sql in name order, once each, recorded in schema_migrations.
// Each file runs in its own transaction. A changed file that was already applied stops the run.
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { closeDb, db } from './pool';

const DIR = resolve(process.cwd(), 'migrations');
const LOCK_ID = 7_301_001; // advisory lock so two migrate runs cannot interleave

async function main(): Promise<void> {
  const client = await db().connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [LOCK_ID]);
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name        text PRIMARY KEY,
        checksum    char(64) NOT NULL,
        applied_at  timestamptz NOT NULL DEFAULT now()
      )`);
    const applied = new Map<string, string>(
      (await client.query('SELECT name, checksum FROM schema_migrations')).rows.map((r) => [r.name, r.checksum]),
    );

    const files = readdirSync(DIR).filter((f) => f.endsWith('.sql')).sort();
    let ran = 0;
    for (const file of files) {
      const sql = readFileSync(resolve(DIR, file), 'utf8');
      const checksum = createHash('sha256').update(sql).digest('hex');
      const prior = applied.get(file);
      if (prior) {
        if (prior !== checksum) throw new Error(`${file} changed after it was applied. Add a new migration instead.`);
        continue;
      }
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)', [file, checksum]);
        await client.query('COMMIT');
      } catch (e) {
        await client.query('ROLLBACK');
        throw new Error(`${file} failed: ${(e as Error).message}`);
      }
      console.log(`applied ${file}`);
      ran++;
    }
    console.log(ran ? `${ran} migration(s) applied.` : 'Database is up to date.');
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [LOCK_ID]).catch(() => {});
    client.release();
    await closeDb();
  }
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
