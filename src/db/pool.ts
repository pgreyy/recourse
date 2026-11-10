import pg from 'pg';
import { config } from '../config';

let pool: pg.Pool | undefined;

/** Shared connection pool for DATABASE_URL (Neon). Created on first use. */
export function db(): pg.Pool {
  if (!pool) {
    pool = new pg.Pool({ connectionString: config.databaseUrl(), max: 5 });
    pool.on('error', (e) => console.error('postgres pool error:', e.message));
  }
  return pool;
}

/** Run `fn` inside BEGIN/COMMIT; rolls back on any error. */
export async function tx<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await db().connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

export async function closeDb(): Promise<void> {
  await pool?.end();
  pool = undefined;
}
