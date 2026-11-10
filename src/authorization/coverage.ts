import type pg from 'pg';
import { db } from '../shared/db/pool';

export const NOT_COVERED = 'agent not covered by an operator liability agreement';

export type Coverage =
  | { covered: true; agreement_id: string; agreement_version: number; operator_id: string; operator_name: string }
  | { covered: false; reason: string; operator_id: string | null; operator_name: string | null };

/**
 * Is this agent version covered by its operator's ACCEPTED liability agreement? Covered agents get
 * the normal merchant policy; uncovered agents get STEP_UP_REQUIRED on every checkout, because no
 * one has agreed in advance to pay for their mistakes.
 */
export async function agentCoverage(agentVersionId: string, c: pg.Pool | pg.PoolClient = db()): Promise<Coverage> {
  const op = await c.query<{ operator_id: string; operator_name: string; operator_status: string; agent_status: string; version_status: string }>(
    `SELECT o.id AS operator_id, o.name AS operator_name, o.status AS operator_status, a.status AS agent_status, v.status AS version_status
     FROM agent_versions v JOIN agents a ON a.id = v.agent_id JOIN operators o ON o.id = a.operator_id WHERE v.id = $1`,
    [agentVersionId],
  );
  const row = op.rows[0];
  if (!row) return { covered: false, reason: `${NOT_COVERED} (unknown agent version)`, operator_id: null, operator_name: null };
  const { rows } = await c.query<{ id: string; version: number }>(
    `SELECT la.id, la.version FROM liability_agreements la
     JOIN liability_agreement_agent_versions x ON x.liability_agreement_id = la.id
     WHERE la.status = 'ACCEPTED' AND x.agent_version_id = $1`,
    [agentVersionId],
  );
  if (!rows[0] || row.operator_status !== 'ACTIVE' || row.agent_status !== 'ACTIVE' || row.version_status !== 'ACTIVE') {
    return { covered: false, reason: NOT_COVERED, operator_id: row.operator_id, operator_name: row.operator_name };
  }
  return { covered: true, agreement_id: rows[0].id, agreement_version: rows[0].version, operator_id: row.operator_id, operator_name: row.operator_name };
}
