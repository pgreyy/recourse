import type pg from 'pg';
import { canonicalize, sha256Hex } from '../crypto/canonical';
import { db, tx } from '../db/pool';

export const GENESIS_HASH = '0'.repeat(64);

/** hash = sha256_hex(prev_hash || canonical_json(payload)) */
export function entryHash(prevHash: string, payload: unknown): string {
  return sha256Hex(prevHash + canonicalize(payload));
}

export type RecorderEntry = {
  case_ref: string;
  seq: number;
  kind: string;
  payload: unknown;
  prev_hash: string;
  hash: string;
  created_at: Date;
};

/**
 * Append one entry to a case's chain. A per-case advisory lock serializes appends, so two writers
 * can't both take the same seq. The payload is normalized through JSON first so it hashes the same
 * way it will read back from jsonb (undefined members dropped, Dates as ISO strings).
 */
export async function appendEntry(caseRef: string, kind: string, payload: unknown, client?: pg.PoolClient): Promise<RecorderEntry> {
  const normalized = JSON.parse(JSON.stringify(payload ?? null));
  const run = async (c: pg.PoolClient) => {
    await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [caseRef]);
    const last = await c.query<{ seq: number; hash: string }>(
      'SELECT seq, hash FROM recorder_entries WHERE case_ref = $1 ORDER BY seq DESC LIMIT 1',
      [caseRef],
    );
    const seq = (last.rows[0]?.seq ?? 0) + 1;
    const prevHash = last.rows[0]?.hash.trim() ?? GENESIS_HASH;
    const hash = entryHash(prevHash, normalized);
    const { rows } = await c.query<RecorderEntry>(
      `INSERT INTO recorder_entries (case_ref, seq, kind, payload, prev_hash, hash)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING case_ref, seq, kind, payload, prev_hash, hash, created_at`,
      [caseRef, seq, kind, JSON.stringify(normalized), prevHash, hash],
    );
    return rows[0];
  };
  return client ? run(client) : tx(run);
}

export async function listEntries(caseRef: string): Promise<RecorderEntry[]> {
  const { rows } = await db().query<RecorderEntry>(
    'SELECT case_ref, seq, kind, payload, prev_hash, hash, created_at FROM recorder_entries WHERE case_ref = $1 ORDER BY seq',
    [caseRef],
  );
  return rows.map((r) => ({ ...r, prev_hash: r.prev_hash.trim(), hash: r.hash.trim() }));
}

export type VerifyResult = {
  case_ref: string;
  valid: boolean;
  entries: number;
  head_hash: string | null;
  first_broken_seq: number | null;
  problem: null | {
    reason: 'SEQ_GAP' | 'PREV_HASH_MISMATCH' | 'HASH_MISMATCH';
    expected: string | number;
    found: string | number;
  };
};

/**
 * Walk the chain from seq 1 and report the first entry that does not check out:
 * a missing seq, a prev_hash that is not the previous entry's hash, or a stored hash that does not
 * match the recomputed one (payload, prev_hash or hash edited).
 */
export function verifyChain(caseRef: string, entries: RecorderEntry[]): VerifyResult {
  let prev = GENESIS_HASH;
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    const broken = (reason: NonNullable<VerifyResult['problem']>['reason'], expected: string | number, found: string | number): VerifyResult => ({
      case_ref: caseRef,
      valid: false,
      entries: entries.length,
      head_hash: entries[entries.length - 1].hash,
      first_broken_seq: e.seq,
      problem: { reason, expected, found },
    });
    if (e.seq !== i + 1) return broken('SEQ_GAP', i + 1, e.seq);
    if (e.prev_hash !== prev) return broken('PREV_HASH_MISMATCH', prev, e.prev_hash);
    const recomputed = entryHash(e.prev_hash, e.payload);
    if (recomputed !== e.hash) return broken('HASH_MISMATCH', recomputed, e.hash);
    prev = e.hash;
  }
  return {
    case_ref: caseRef,
    valid: true,
    entries: entries.length,
    head_hash: entries.length ? entries[entries.length - 1].hash : null,
    first_broken_seq: null,
    problem: null,
  };
}
