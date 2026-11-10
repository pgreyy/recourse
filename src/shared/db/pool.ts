import pg from 'pg';
import { config } from '../../config';

/**
 * Errors where the connection was never established (DNS or TCP connect). Retrying them can't run a
 * statement twice. WSL's DNS relay drops lookups now and then; these retries ride over that.
 */
const CONNECT_ERRORS = new Set(['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ETIMEDOUT', 'ENETUNREACH']);
const MAX_ATTEMPTS = 6;

async function withConnectRetry<T>(fn: () => Promise<T>): Promise<T> {
  for (let n = 1; ; n++) {
    try {
      return await fn();
    } catch (e) {
      const code = (e as { code?: string })?.code ?? '';
      if (!CONNECT_ERRORS.has(code) || n >= MAX_ATTEMPTS) throw e;
      console.error(`postgres: ${code}, retrying connection (${n}/${MAX_ATTEMPTS})`);
      await new Promise((ok) => setTimeout(ok, 1500 * n));
    }
  }
}

let pool: pg.Pool | undefined;

/** Shared connection pool for DATABASE_URL (Neon). Created on first use; connects retry DNS/connect failures. */
export function db(): pg.Pool {
  if (!pool) {
    const p = new pg.Pool({ connectionString: config.databaseUrl(), max: 5, connectionTimeoutMillis: 15_000 });
    p.on('error', (e) => console.error('postgres pool error:', e.message));
    const query = p.query.bind(p) as (...args: unknown[]) => Promise<unknown>;
    const connect = p.connect.bind(p) as (...args: unknown[]) => Promise<pg.PoolClient>;
    (p as unknown as { query: unknown }).query = (...args: unknown[]) =>
      typeof args[args.length - 1] === 'function' ? query(...args) : withConnectRetry(() => query(...args));
    (p as unknown as { connect: unknown }).connect = (...args: unknown[]) =>
      args.length ? connect(...args) : withConnectRetry(() => connect());
    pool = p;
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
