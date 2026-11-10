import type pg from 'pg';
import { db } from '../shared/db/pool';

export type MandateUsage = { spent_cents: number; orders_placed: number; units_bought: number };

/**
 * What has been bought under a mandate lineage (all versions): captured orders only. The aggregate
 * budget, max_orders and quantity rules are all checked against this.
 */
export async function mandateUsage(lineageId: string, c: pg.Pool | pg.PoolClient = db()): Promise<MandateUsage> {
  const { rows } = await c.query<{ spent: string | null; n: string; units: string | null }>(
    `SELECT SUM(total_value) AS spent, COUNT(*) AS n,
            SUM((SELECT COALESCE(SUM((l->>'quantity')::int), 0) FROM jsonb_array_elements(lines) l)) AS units
     FROM orders WHERE mandate_lineage_id = $1 AND status IN ('CAPTURED', 'PARTIALLY_REFUNDED')`,
    [lineageId],
  );
  return {
    spent_cents: Math.round(Number(rows[0].spent ?? 0) * 100),
    orders_placed: Number(rows[0].n),
    units_bought: Number(rows[0].units ?? 0),
  };
}
