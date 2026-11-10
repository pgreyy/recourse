// npm run demo:restore -- A|B [--with-reputation] [--neon]
// Puts an archived scenario back into the live tables, with its original ids, so the console shows it
// again (for example if a live rerun fails during judging). Adds rows only; anything already there is kept.
import '../config';
import { closeDb, tx } from '../shared/db/pool';
import { ARCHIVE_TABLES, guardDatabase } from './common';

async function main() {
  const argv = process.argv.slice(2);
  const label = argv.find((a) => !a.startsWith('--'))?.toUpperCase();
  const { host } = guardDatabase(argv);
  if (!label) throw new Error('Say which scenario: npm run demo:restore -- A');
  console.log(`Database: ${host}`);
  const out = await tx(async (c) => {
    const rows = new Map((await c.query('SELECT table_name, rows FROM demo_archive WHERE label = $1', [label])).rows.map((r) => [r.table_name, r.rows as any[]]));
    if (!rows.size) throw new Error(`No archived scenario ${label}.`);
    const done: string[] = [];
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
    return done;
  });
  console.log(`restored ${label}: ${out.join(', ')}`);
}

main()
  .catch((e) => {
    console.error(e.message);
    process.exitCode = 1;
  })
  .finally(() => closeDb());
