// npm run demo:restore -- A|B [--with-reputation] [--check] [--neon]
// Puts an archived scenario back into the live tables, with its original ids, so the console shows it
// again (for example if a live rerun fails during judging). Adds rows only; anything already there is kept.
// --check restores inside a transaction, verifies the hash chain, the checkpoint and instruction signatures,
// then rolls everything back: nothing is left in the database.
import '../config';
import type pg from 'pg';
import { closeDb, tx } from '../shared/db/pool';
import { checkMandateSignature } from '../authorization/mandate-document';
import { verifyChain } from '../evidence/recorder';
import { ARCHIVE_TABLES, RETAIL_TABLES, guardDatabase, SCENARIOS } from './common';

class CheckDone extends Error {}

async function verify(c: pg.PoolClient, caseRef: string, mandateIds: string[]): Promise<string[]> {
  const entries = (await c.query('SELECT case_ref, seq, kind, payload, prev_hash, hash, created_at FROM recorder_entries WHERE case_ref = $1 ORDER BY seq', [caseRef])).rows
    .map((r) => ({ ...r, prev_hash: r.prev_hash.trim(), hash: r.hash.trim() }));
  const cps = (await c.query('SELECT case_ref, seq, head_hash, signed_at, signing_key_id, signature FROM recorder_checkpoints WHERE case_ref = $1 ORDER BY seq', [caseRef])).rows
    .map((r) => ({ ...r, head_hash: r.head_hash.trim() }));
  const v = verifyChain(caseRef, entries, cps);
  const mandates = (await c.query(
    `SELECT m.*, b.email AS buyer_email, pt.vault_id FROM mandates m JOIN buyers b ON b.id = m.buyer_id
       LEFT JOIN payment_tokens pt ON pt.id = m.payment_token_id
      WHERE m.signature IS NOT NULL AND m.id = ANY($1::uuid[])`,
    [mandateIds],
  )).rows;
  const sigs = mandates.map((m) => checkMandateSignature(m).signature_valid);
  const shown = (await c.query('SELECT status FROM cases WHERE case_ref = $1', [caseRef])).rows[0]?.status ?? 'MISSING';
  return [
    `case ${caseRef} ${shown}`,
    `chain valid ${v.valid} (${v.entries} entries)`,
    `checkpoint signatures valid ${v.checkpoints.all_signatures_valid} (${cps.length})`,
    `signatures on the instructions valid ${sigs.length > 0 && sigs.every(Boolean)} (${sigs.length})`,
  ];
}

async function main() {
  const argv = process.argv.slice(2);
  const label = argv.find((a) => !a.startsWith('--'))?.toUpperCase();
  const { host } = guardDatabase(argv);
  if (!label) throw new Error('Say which scenario: npm run demo:restore -- A');
  console.log(`Database: ${host}`);
  const check = argv.includes('--check');
  let report: string[] = [];
  const out = await tx(async (c) => {
    const rows = new Map((await c.query('SELECT table_name, rows FROM demo_archive WHERE label = $1', [label])).rows.map((r) => [r.table_name, r.rows as any[]]));
    if (!rows.size) throw new Error(`No archived scenario ${label}.`);
    const done: string[] = [];
    // The retail scenarios need the retail operator, agents and agreements back first (archived as RETAIL by the reset).
    const retail = new Map((await c.query(`SELECT table_name, rows FROM demo_archive WHERE label = 'RETAIL'`)).rows.map((r) => [r.table_name, r.rows as any[]]));
    for (const t of RETAIL_TABLES) {
      const data = retail.get(t) ?? [];
      if (!data.length) continue;
      const r = await c.query(`INSERT INTO ${t} OVERRIDING SYSTEM VALUE SELECT * FROM json_populate_recordset(NULL::${t}, $1) x ON CONFLICT DO NOTHING`, [JSON.stringify(data)]);
      done.push(`retail ${t} ${r.rowCount}/${data.length}`);
    }
    for (const t of ARCHIVE_TABLES) {
      let data = rows.get(t) ?? [];
      // Reputation is left out unless asked: restored history should not put an agent on step-up during a live rerun.
      if (t === 'reputation_events' && !argv.includes('--with-reputation')) continue;
      if (!data.length) continue;
      // An operator has one accepted agreement at a time: an archived one comes back as superseded.
      if (t === 'liability_agreements') data = data.map((r) => (r.status === 'ACCEPTED' ? { ...r, status: 'SUPERSEDED' } : r));
      // An archived saved PayPal comes back only if its vault id is not already live.
      // Coverage rows for agent versions the reset removed are skipped (the signed terms still list them).
      const only = t === 'liability_agreement_agent_versions' ? ' WHERE EXISTS (SELECT 1 FROM agent_versions v WHERE v.id = x.agent_version_id)' : '';
      const r = await c.query(`INSERT INTO ${t} OVERRIDING SYSTEM VALUE SELECT * FROM json_populate_recordset(NULL::${t}, $1) x${only} ON CONFLICT DO NOTHING`, [JSON.stringify(data)]);
      done.push(`${t} ${r.rowCount}/${data.length}`);
    }
    if (check) {
      report = [`restored ${label} (inside a transaction): ${done.join(', ')}`, ...(await verify(c, SCENARIOS[label], (rows.get('mandates') ?? []).map((m) => m.id)))];
      throw new CheckDone();
    }
    return done;
  }).catch((e) => {
    if (e instanceof CheckDone) return null;
    throw e;
  });
  if (out) console.log(`restored ${label}: ${out.join(', ')}`);
  else console.log([...report, 'check only: rolled back, nothing kept'].join('\n'));
}

main()
  .catch((e) => {
    console.error(e.message);
    process.exitCode = 1;
  })
  .finally(() => closeDb());
