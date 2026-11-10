import type pg from 'pg';
import { canonicalize, sha256Hex } from '../shared/crypto/canonical';
import { checkDocument, loadSigner, signDocument } from '../shared/crypto/signing';
import { db, tx } from '../shared/db/pool';

/**
 * Flight recorder: an append-only hash chain per case, plus signed checkpoints of the chain head.
 * This module is the only code that touches recorder tables, and it has no update or delete path.
 *
 * hash = sha256_hex(prev_hash || canonical_json({case_ref, seq, kind, recorded_at, payload}))
 * Hashing the whole entry (not only the payload) means changing an entry's kind, seq or time is
 * detected too. After every append, the new head is signed into recorder_checkpoints, so deleting
 * entries from the end of the chain is detected against the last checkpoint.
 */
export const GENESIS_HASH = '0'.repeat(64);

export type RecorderEntry = {
  case_ref: string;
  seq: number;
  kind: string;
  payload: unknown;
  prev_hash: string;
  hash: string;
  created_at: Date;
};

export type Checkpoint = {
  case_ref: string;
  seq: number;
  head_hash: string;
  signed_at: Date;
  signing_key_id: string;
  signature: string;
};

function hashedBody(e: { case_ref: string; seq: number; kind: string; recorded_at: string; payload: unknown }) {
  return { case_ref: e.case_ref, seq: e.seq, kind: e.kind, recorded_at: e.recorded_at, payload: e.payload };
}

export function entryHash(prevHash: string, body: ReturnType<typeof hashedBody>): string {
  return sha256Hex(prevHash + canonicalize(body));
}

function checkpointDocument(cp: { case_ref: string; seq: number; head_hash: string; signed_at: Date; signing_key_id: string }) {
  return {
    type: 'recourse.recorder_checkpoint',
    case_ref: cp.case_ref,
    seq: cp.seq,
    head_hash: cp.head_hash,
    signed_at: cp.signed_at.toISOString(),
    signing_key_id: cp.signing_key_id,
  };
}

/**
 * Append one entry and sign a checkpoint of the new head, in one transaction. A per-case advisory
 * lock serializes appends. The payload goes through JSON first so it hashes exactly as it reads back
 * from jsonb (undefined dropped, Dates as ISO strings).
 */
export async function appendEntry(caseRef: string, kind: string, payload: unknown, client?: pg.PoolClient): Promise<RecorderEntry & { checkpoint: Checkpoint }> {
  const normalized = JSON.parse(JSON.stringify(payload ?? null));
  const signer = loadSigner();
  const run = async (c: pg.PoolClient) => {
    await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [caseRef]);
    const last = await c.query<{ seq: number; hash: string }>(
      'SELECT seq, hash FROM recorder_entries WHERE case_ref = $1 ORDER BY seq DESC LIMIT 1',
      [caseRef],
    );
    const seq = (last.rows[0]?.seq ?? 0) + 1;
    const prevHash = last.rows[0]?.hash.trim() ?? GENESIS_HASH;
    const recordedAt = new Date();
    const hash = entryHash(prevHash, hashedBody({ case_ref: caseRef, seq, kind, recorded_at: recordedAt.toISOString(), payload: normalized }));
    const { rows } = await c.query<RecorderEntry>(
      `INSERT INTO recorder_entries (case_ref, seq, kind, payload, prev_hash, hash, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING case_ref, seq, kind, payload, prev_hash, hash, created_at`,
      [caseRef, seq, kind, JSON.stringify(normalized), prevHash, hash, recordedAt],
    );
    const cp = { case_ref: caseRef, seq, head_hash: hash, signed_at: new Date(), signing_key_id: signer.keyId };
    const signed = signDocument(checkpointDocument(cp));
    await c.query(
      `INSERT INTO recorder_checkpoints (case_ref, seq, head_hash, signed_at, signing_key_id, signature) VALUES ($1, $2, $3, $4, $5, $6)`,
      [caseRef, seq, hash, cp.signed_at, cp.signing_key_id, signed.signature],
    );
    return { ...rows[0], checkpoint: { ...cp, signature: signed.signature } };
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

export async function listCheckpoints(caseRef: string): Promise<Checkpoint[]> {
  const { rows } = await db().query<Checkpoint>(
    'SELECT case_ref, seq, head_hash, signed_at, signing_key_id, signature FROM recorder_checkpoints WHERE case_ref = $1 ORDER BY seq',
    [caseRef],
  );
  return rows.map((r) => ({ ...r, head_hash: r.head_hash.trim() }));
}

export type Problem = {
  seq: number;
  reason: 'MODIFIED' | 'DELETED' | 'REORDERED' | 'BROKEN_LINK' | 'MISSING_AT_END' | 'CHECKPOINT_MISMATCH' | 'BAD_CHECKPOINT_SIGNATURE';
  detail: string;
};

export type VerifyResult = {
  case_ref: string;
  valid: boolean;
  entries: number;
  head: { seq: number; hash: string } | null;
  first_problem: Problem | null;
  problems: Problem[];
  checkpoints: {
    count: number;
    latest_seq: number | null;
    signatures_valid: number;
    all_signatures_valid: boolean;
    consistent_with_chain: boolean;
  };
};

/**
 * Walk the chain in seq order and check every signed checkpoint against it. Reports, by seq:
 *  DELETED              a seq is missing in the middle
 *  REORDERED            an entry's prev_hash points at an entry that now sits later in the chain
 *  BROKEN_LINK          prev_hash matches no entry
 *  MODIFIED             the stored hash no longer matches the entry's contents
 *  MISSING_AT_END       a signed checkpoint covers seqs that are no longer there
 *  CHECKPOINT_MISMATCH  the entry at a checkpoint's seq has a different hash than was signed
 *  BAD_CHECKPOINT_SIGNATURE  a checkpoint's signature does not verify
 */
export function verifyChain(caseRef: string, entries: RecorderEntry[], checkpoints: Checkpoint[]): VerifyResult {
  const problems: Problem[] = [];
  const hashToSeq = new Map(entries.map((e) => [e.hash, e.seq]));
  let prev = GENESIS_HASH;
  let expectedSeq = 1;
  for (const e of entries) {
    if (e.seq !== expectedSeq) {
      const missing = e.seq - expectedSeq;
      problems.push({
        seq: expectedSeq,
        reason: 'DELETED',
        detail: missing === 1 ? `seq ${expectedSeq} is missing` : `seqs ${expectedSeq} to ${e.seq - 1} are missing`,
      });
    } else if (e.prev_hash !== prev) {
      const pointsAt = hashToSeq.get(e.prev_hash);
      problems.push(
        pointsAt !== undefined && pointsAt > e.seq
          ? { seq: e.seq, reason: 'REORDERED', detail: `entry at seq ${e.seq} follows the entry now at seq ${pointsAt}` }
          : { seq: e.seq, reason: 'BROKEN_LINK', detail: `prev_hash does not match the hash of seq ${e.seq - 1}` },
      );
    }
    const recomputed = entryHash(
      e.prev_hash,
      hashedBody({ case_ref: e.case_ref, seq: e.seq, kind: e.kind, recorded_at: e.created_at.toISOString(), payload: e.payload }),
    );
    if (recomputed !== e.hash && !problems.some((p) => p.seq === e.seq && p.reason === 'REORDERED')) {
      problems.push({ seq: e.seq, reason: 'MODIFIED', detail: 'stored hash does not match the entry (payload, kind, seq or time changed)' });
    }
    prev = e.hash;
    expectedSeq = e.seq + 1;
  }

  const bySeq = new Map(entries.map((e) => [e.seq, e]));
  const maxSeq = entries.length ? entries[entries.length - 1].seq : 0;
  let signaturesValid = 0;
  let consistent = true;
  for (const cp of checkpoints) {
    const sig = checkDocument(checkpointDocument(cp), { signature: cp.signature, keyId: cp.signing_key_id });
    if (sig.valid) signaturesValid++;
    else problems.push({ seq: cp.seq, reason: 'BAD_CHECKPOINT_SIGNATURE', detail: `checkpoint at seq ${cp.seq}: ${sig.reason}` });
    const entry = bySeq.get(cp.seq);
    if (cp.seq > maxSeq) {
      consistent = false;
      if (!problems.some((p) => p.reason === 'MISSING_AT_END')) {
        problems.push({ seq: maxSeq + 1, reason: 'MISSING_AT_END', detail: `a signed checkpoint covers seq ${cp.seq}, but the chain ends at seq ${maxSeq}` });
      }
    } else if (entry && entry.hash !== cp.head_hash) {
      consistent = false;
      problems.push({ seq: cp.seq, reason: 'CHECKPOINT_MISMATCH', detail: `entry at seq ${cp.seq} differs from the head signed at that seq` });
    }
  }

  const order = ['DELETED', 'REORDERED', 'BROKEN_LINK', 'MODIFIED', 'MISSING_AT_END', 'CHECKPOINT_MISMATCH', 'BAD_CHECKPOINT_SIGNATURE'];
  problems.sort((a, b) => a.seq - b.seq || order.indexOf(a.reason) - order.indexOf(b.reason));
  const last = entries[entries.length - 1];
  return {
    case_ref: caseRef,
    valid: problems.length === 0,
    entries: entries.length,
    head: last ? { seq: last.seq, hash: last.hash } : null,
    first_problem: problems[0] ?? null,
    problems,
    checkpoints: {
      count: checkpoints.length,
      latest_seq: checkpoints.length ? checkpoints[checkpoints.length - 1].seq : null,
      signatures_valid: signaturesValid,
      all_signatures_valid: signaturesValid === checkpoints.length,
      consistent_with_chain: consistent,
    },
  };
}
