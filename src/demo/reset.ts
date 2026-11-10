// npm run demo:reset -- --yes [--neon]
// Archives scenario A and B, wipes the test data, and seeds a clean demo. See docs/demo-reset.md.
import { spawnSync } from 'node:child_process';
import type pg from 'pg';
import '../config';
import { env } from '../config';
import { closeDb, db, tx } from '../shared/db/pool';
import { AGENT_NAME, AGENT_VERSIONS, UNCOVERED } from '../transaction/agent/versions';
import { AgreementRequest, buildTerms, signAcceptance, termsHash, type AgreementRow } from '../authorization/liability-agreements';
import { ARCHIVE_TABLES, SCENARIOS, guardDatabase } from './common';

const ACME = 'Acme Shopping Agents';
const BRANDS = /\b(nike|asics|adidas|brooks|pegasus|gel-nimbus|hoka|saucony|new balance|on cloud)\b/i;

const q = async (c: pg.PoolClient, sql: string, params: unknown[] = []) => (await c.query(sql, params)).rows;

/** Every row that belongs to one recorded case_ref, table by table (test self-test disputes excluded). */
async function collect(c: pg.PoolClient, caseRef: string): Promise<Record<string, unknown[]>> {
  const cases = await q(c, `SELECT * FROM cases WHERE case_ref = $1 AND (dispute_id IS NULL OR dispute_id NOT LIKE 'SELFTEST-%')`, [caseRef]);
  const caseIds = cases.map((r) => r.id);
  const orders = await q(c, 'SELECT * FROM orders WHERE case_ref = $1', [caseRef]);
  const orderIds = orders.map((r) => r.id);
  const runs = await q(c, 'SELECT * FROM agent_runs WHERE case_ref = $1', [caseRef]);
  const lineages = [...new Set(orders.map((o) => o.mandate_lineage_id))];
  const mandates = await q(c, 'SELECT * FROM mandates WHERE lineage_id = ANY($1::uuid[]) OR id = ANY($2::uuid[]) ORDER BY version', [lineages, runs.map((r) => r.mandate_id)]);
  const buyers = await q(c, 'SELECT * FROM buyers WHERE id = ANY($1::uuid[])', [mandates.map((m) => m.buyer_id)]);
  const rulings = await q(c, 'SELECT * FROM rulings WHERE case_id = ANY($1::uuid[])', [caseIds]);
  const obligations = await q(c, 'SELECT * FROM settlement_obligations WHERE case_id = ANY($1::uuid[])', [caseIds]);
  const agreementIds = [...new Set(obligations.map((o) => o.liability_agreement_id).filter(Boolean))];
  const entries = await q(c, 'SELECT * FROM recorder_entries WHERE case_ref = $1 ORDER BY seq', [caseRef]);
  const shas = entries.map((e) => e.payload?.catalog_snapshot_sha256).filter(Boolean);
  const carts = await q(c, 'SELECT * FROM carts WHERE case_ref = $1', [caseRef]);
  return {
    buyers,
    payment_tokens: await q(c, 'SELECT * FROM payment_tokens WHERE id = ANY($1::uuid[])', [mandates.map((m) => m.payment_token_id).filter(Boolean)]),
    liability_agreements: await q(c, 'SELECT * FROM liability_agreements WHERE id = ANY($1::uuid[])', [agreementIds]),
    liability_agreement_agent_versions: await q(c, 'SELECT * FROM liability_agreement_agent_versions WHERE liability_agreement_id = ANY($1::uuid[])', [agreementIds]),
    mandates,
    catalog_snapshots: await q(c, 'SELECT * FROM catalog_snapshots WHERE id = ANY($1::uuid[]) OR sha256 = ANY($2::text[])', [carts.map((x) => x.last_snapshot_id).filter(Boolean), shas]),
    carts,
    agent_runs: runs,
    orders,
    step_ups: await q(c, 'SELECT * FROM step_ups WHERE case_ref = $1', [caseRef]),
    receipts: await q(c, 'SELECT * FROM receipts WHERE order_id = ANY($1::uuid[])', [orderIds]),
    cases,
    case_statements: await q(c, 'SELECT * FROM case_statements WHERE case_id = ANY($1::uuid[])', [caseIds]),
    assessments: await q(c, 'SELECT * FROM assessments WHERE case_id = ANY($1::uuid[])', [caseIds]),
    rulings,
    appeals: await q(c, 'SELECT * FROM appeals WHERE ruling_id = ANY($1::uuid[])', [rulings.map((r) => r.id)]),
    settlement_obligations: obligations,
    settlement_actions: await q(c, 'SELECT * FROM settlement_actions WHERE obligation_id = ANY($1::uuid[])', [obligations.map((o) => o.id)]),
    reputation_events: await q(c, 'SELECT * FROM reputation_events WHERE ruling_id = ANY($1::uuid[])', [rulings.map((r) => r.id)]),
    recorder_entries: entries,
    recorder_checkpoints: await q(c, 'SELECT * FROM recorder_checkpoints WHERE case_ref = $1 ORDER BY seq', [caseRef]),
    paypal_events: await q(c, 'SELECT * FROM paypal_events WHERE order_id = ANY($1::uuid[])', [orderIds]),
  };
}

async function archive(c: pg.PoolClient) {
  const out: string[] = [];
  for (const [label, caseRef] of Object.entries(SCENARIOS)) {
    const have = await q(c, 'SELECT 1 FROM demo_archive WHERE label = $1 LIMIT 1', [label]);
    if (have.length) {
      out.push(`${label}: already archived, kept as is`);
      continue;
    }
    const rows = await collect(c, caseRef);
    if (!rows.cases.length && !rows.orders.length) {
      out.push(`${label}: ${caseRef} not found, nothing archived`);
      continue;
    }
    for (const t of ARCHIVE_TABLES) {
      await c.query('INSERT INTO demo_archive (label, table_name, rows) VALUES ($1, $2, $3)', [label, t, JSON.stringify(rows[t] ?? [])]);
    }
    out.push(`${label}: ${caseRef} archived (${ARCHIVE_TABLES.map((t) => `${t} ${rows[t]?.length ?? 0}`).filter((s) => !s.endsWith(' 0')).join(', ')})`);
  }
  return out;
}

async function wipe(c: pg.PoolClient) {
  const n: Record<string, number> = {};
  const del = async (label: string, sql: string, params: unknown[] = []) => {
    n[label] = (n[label] ?? 0) + ((await c.query(sql, params)).rowCount ?? 0);
  };
  // Case, settlement and evidence history (all of it; A and B are in demo_archive).
  for (const t of ['reputation_events', 'settlement_actions', 'appeals', 'settlement_obligations', 'case_verifications', 'rulings', 'case_statements']) await del(t, `DELETE FROM ${t}`);
  // Assessments: keep only the fixture assessments of the scorecard runs we keep (the latest run per model).
  const keepRuns = (
    await q(c, `SELECT DISTINCT ON (model_provider, model_id) id FROM scorecard_runs ORDER BY model_provider, model_id, finished_at DESC NULLS LAST`)
  ).map((r) => r.id);
  await del('assessments', `DELETE FROM assessments WHERE case_id IS NOT NULL OR scorecard_run_id IS NULL OR NOT (scorecard_run_id = ANY($1::uuid[]))`, [keepRuns]);
  await del('scorecard_runs', 'DELETE FROM scorecard_runs WHERE NOT (id = ANY($1::uuid[]))', [keepRuns]);
  for (const t of ['cases', 'paypal_events', 'receipts', 'step_ups', 'orders', 'agent_runs', 'carts', 'catalog_snapshots', 'recorder_checkpoints', 'recorder_entries']) await del(t, `DELETE FROM ${t}`);
  await c.query('UPDATE mandates SET supersedes_id = NULL');
  await del('mandates', 'DELETE FROM mandates');

  // Operators: keep one Acme (the one whose saved PayPal is active) and one Drift; remove the rest.
  const acme = (
    await q(
      c,
      `SELECT o.id FROM operators o LEFT JOIN payment_tokens t ON t.operator_id = o.id AND t.owner_type = 'OPERATOR' AND t.status = 'ACTIVE'
       WHERE o.name = $1 ORDER BY (t.id IS NOT NULL) DESC, o.created_at LIMIT 1`,
      [ACME],
    )
  )[0]?.id ?? null;
  const drift = (await q(c, 'SELECT id FROM operators WHERE name = $1 ORDER BY created_at LIMIT 1', [UNCOVERED.operator]))[0]?.id ?? null;
  const keepOps = [acme, drift].filter(Boolean);

  // Saved PayPal: keep every ACTIVE token of buyers and of Acme (PayPal returns the same vault id for the same
  // payer and merchant, so these are reused); drop pending, failed, revoked ones and other operators' tokens.
  await del('payment_tokens', `DELETE FROM payment_tokens WHERE status <> 'ACTIVE' OR (owner_type = 'OPERATOR' AND operator_id IS DISTINCT FROM $1)`, [acme]);
  // Agents: only the demo agent versions survive, with their ids (archived runs refer to them).
  const demoVersions: Array<[string | null, string, string[]]> = [
    [acme, AGENT_NAME, AGENT_VERSIONS.map((v) => v.version)],
    [drift, UNCOVERED.agent, [UNCOVERED.version]],
  ];
  const keepVersionIds: string[] = [];
  for (const [op, name, versions] of demoVersions) {
    if (!op) continue;
    const rows = await q(c, `SELECT v.id FROM agent_versions v JOIN agents a ON a.id = v.agent_id WHERE a.operator_id = $1 AND a.name = $2 AND v.version = ANY($3::text[])`, [op, name, versions]);
    keepVersionIds.push(...rows.map((r) => r.id));
  }
  await del('liability_agreement_agent_versions', 'DELETE FROM liability_agreement_agent_versions');
  await del('agent_versions', 'DELETE FROM agent_versions WHERE NOT (id = ANY($1::uuid[]))', [keepVersionIds]);
  await del('agents', 'DELETE FROM agents a WHERE NOT EXISTS (SELECT 1 FROM agent_versions v WHERE v.agent_id = a.id)');

  // Agreements: a fresh accepted v1 for Acme covering exactly the demo versions. Acme's saved PayPal moves onto
  // it (an operator token always belongs to an agreement), then every older agreement is deleted.
  let agreementNote = 'none (no saved PayPal for Acme yet; seed:agents creates the agreement)';
  const token = acme ? (await q(c, `SELECT id FROM payment_tokens WHERE operator_id = $1 AND owner_type = 'OPERATOR' AND status = 'ACTIVE'`, [acme]))[0] : null;
  if (acme && token) {
    const op = (await q(c, 'SELECT id, name, email FROM operators WHERE id = $1', [acme]))[0];
    await c.query(`UPDATE liability_agreements SET status = 'SUPERSEDED', version = version + 100000 WHERE operator_id = $1`, [acme]);
    const req = AgreementRequest.parse({});
    const terms = await buildTerms(c, op, 1, req);
    const ag = (
      await c.query<AgreementRow>(
        `INSERT INTO liability_agreements (operator_id, version, terms, terms_hash, per_incident_cap, aggregate_cap, currency, appeal_window_hours)
         VALUES ($1, 1, $2, $3, $4, $5, $6, $7) RETURNING *`,
        [acme, JSON.stringify(terms), termsHash(terms), req.per_incident_cap.value, req.aggregate_cap.value, req.aggregate_cap.currency, req.appeal_window_hours],
      )
    ).rows[0];
    for (const v of terms.covered_agent_versions) await c.query('INSERT INTO liability_agreement_agent_versions (liability_agreement_id, agent_version_id) VALUES ($1, $2)', [ag.id, v.agent_version_id]);
    const by = { name: 'Acme Ops (demo reset)', email: op.email };
    const at = new Date();
    const signed = signAcceptance(ag, by, at);
    await c.query(
      `UPDATE liability_agreements SET status = 'ACCEPTED', accepted_at = $2, accepted_by_name = $3, accepted_by_email = $4,
         acceptance_hash = $5, acceptance_signature = $6, signing_key_id = $7 WHERE id = $1`,
      [ag.id, at, by.name, by.email, signed.acceptanceHash, signed.signature, signed.keyId],
    );
    await c.query('UPDATE payment_tokens SET liability_agreement_id = $1 WHERE id = $2', [ag.id, token.id]);
    agreementNote = `Acme agreement v1 accepted, covering ${terms.covered_agent_versions.map((v) => `${v.agent_name} ${v.version}`).join(', ')}; Acme's saved PayPal linked to it`;
  }
  await del('liability_agreements', 'DELETE FROM liability_agreements la WHERE NOT EXISTS (SELECT 1 FROM payment_tokens t WHERE t.liability_agreement_id = la.id)');
  await del('operators', 'DELETE FROM operators WHERE NOT (id = ANY($1::uuid[]))', [keepOps]);
  await c.query(`UPDATE operators SET status = 'ACTIVE' WHERE id = ANY($1::uuid[])`, [keepOps]);
  return { deleted: n, acme, drift, keptScorecardRuns: keepRuns.length, agreementNote };
}

function runScript(label: string, file: string) {
  const r = spawnSync(process.execPath, ['--import', 'tsx', file], { stdio: ['ignore', 'pipe', 'pipe'], env: process.env, encoding: 'utf8' });
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`.split('\n').filter((l) => l.trim() && !/ExperimentalWarning|--trace-warnings/.test(l));
  if (r.status !== 0) throw new Error(`${label} failed:\n${out.join('\n')}`);
  return out;
}

async function main() {
  const argv = process.argv.slice(2);
  const { host } = guardDatabase(argv);
  if (!argv.includes('--yes')) {
    console.log(`demo:reset would archive scenarios ${Object.entries(SCENARIOS).map(([k, v]) => `${k} (${v})`).join(' and ')} into demo_archive,`);
    console.log('delete every case, order, mandate, agent run, snapshot and recorder entry, keep one Acme and one Drift operator,');
    console.log('rebuild the agreements, reseed the catalog and agents, and keep the latest scorecard run per model.');
    console.log(`Database: ${host}. Nothing done. Run again with --yes to do it.`);
    return;
  }
  console.log(`Database: ${host}`);
  const step1 = await tx(async (c) => {
    const archived = await archive(c);
    const wiped = await wipe(c);
    return { archived, wiped };
  });
  step1.archived.forEach((l) => console.log(`archive ${l}`));
  console.log(`deleted: ${Object.entries(step1.wiped.deleted).filter(([, v]) => v).map(([k, v]) => `${k} ${v}`).join(', ')}`);
  console.log(`kept: scorecard runs ${step1.wiped.keptScorecardRuns}`);
  console.log(`operator: ${step1.wiped.agreementNote}`);

  runScript('catalog seed', 'src/transaction/seed.ts').forEach((l) => console.log(`seed: ${l}`));
  runScript('agent seed', 'src/transaction/agent/seed-agents.ts').forEach((l) => console.log(`seed:agents: ${l}`));


  // Proof of a clean demo: no real brand names left anywhere, and the expected rows present.
  const tables = (await db().query<{ t: string }>(`SELECT table_name AS t FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`)).rows.map((r) => r.t);
  const hits: string[] = [];
  for (const t of tables) {
    const n = (await db().query(`SELECT COUNT(*)::int AS n FROM "${t}" x WHERE to_jsonb(x)::text ~* $1`, [BRANDS.source.replace(/\\b/g, '\\y')])).rows[0].n;
    if (n) hits.push(`${t} ${n}`);
  }
  console.log(`real brand names: ${hits.length ? hits.join(', ') : 'none in any table'}`);
  const summary = (
    await db().query(`SELECT (SELECT COUNT(*) FROM operators)::int AS operators, (SELECT COUNT(*) FROM agent_versions)::int AS agent_versions,
      (SELECT COUNT(*) FROM liability_agreements WHERE status = 'ACCEPTED')::int AS accepted_agreements, (SELECT COUNT(*) FROM merchant_variants)::int AS variants,
      (SELECT COUNT(*) FROM cases)::int AS cases, (SELECT COUNT(*) FROM scorecard_runs)::int AS scorecard_runs, (SELECT COUNT(DISTINCT label) FROM demo_archive)::int AS archived_scenarios`)
  ).rows[0];
  console.log(`now: ${Object.entries(summary).map(([k, v]) => `${k} ${v}`).join(', ')}`);
  if (env('PUBLIC_BASE_URL')) console.log(`open ${env('PUBLIC_BASE_URL')}/app/judges`);
}

main()
  .catch((e) => {
    console.error(e.message);
    process.exitCode = 1;
  })
  .finally(() => closeDb());
