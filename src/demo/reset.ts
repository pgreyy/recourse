// npm run demo:reset -- --yes [--neon]
// Archives scenario A and B and the retail set, wipes the test data, and seeds a clean travel demo. See docs/demo-reset.md.
import { spawnSync } from 'node:child_process';
import type pg from 'pg';
import '../config';
import { env } from '../config';
import { closeDb, db, tx } from '../shared/db/pool';
import { TRAVEL_OPERATOR, UNCOVERED } from '../transaction/agent/versions';
import { ARCHIVE_TABLES, RETAIL_TABLES, SCENARIOS, guardDatabase } from './common';

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

  // Retail (the shoe demo): archived as RETAIL, then removed from view. Restoring scenario A or B puts it back.
  const retail = await archiveRetail(c);
  for (const [t, ids] of [
    ['payment_tokens', retail.ids.payment_tokens],
    ['liability_agreement_agent_versions', null],
    ['liability_agreements', retail.ids.liability_agreements],
    ['agent_versions', retail.ids.agent_versions],
    ['agents', retail.ids.agents],
    ['operators', retail.ids.operators],
  ] as Array<[string, string[] | null]>) {
    if (t === 'liability_agreement_agent_versions') {
      await del(t, 'DELETE FROM liability_agreement_agent_versions WHERE liability_agreement_id = ANY($1::uuid[]) OR agent_version_id = ANY($2::uuid[])', [retail.ids.liability_agreements, retail.ids.agent_versions]);
    } else await del(t, `DELETE FROM ${t} WHERE id = ANY($1::uuid[])`, [ids]);
  }

  // Operators now: Drift Commerce (uncovered) and Wayfare Agents (travel), with everything they already have.
  const keepOps = (await q(c, `SELECT id FROM operators WHERE name = ANY($1::text[])`, [[UNCOVERED.operator, TRAVEL_OPERATOR]])).map((r) => r.id);
  // Saved PayPal: keep every ACTIVE token of buyers and of the kept operators (PayPal returns the same vault id for
  // the same payer and merchant, so these are reused); drop pending, failed and revoked ones.
  await del('payment_tokens', `DELETE FROM payment_tokens WHERE status <> 'ACTIVE' OR (owner_type = 'OPERATOR' AND NOT (operator_id = ANY($1::uuid[])))`, [keepOps]);
  await del('liability_agreement_agent_versions', `DELETE FROM liability_agreement_agent_versions x USING liability_agreements la WHERE la.id = x.liability_agreement_id AND NOT (la.operator_id = ANY($1::uuid[]))`, [keepOps]);
  await del('liability_agreements', `DELETE FROM liability_agreements la WHERE NOT (la.operator_id = ANY($1::uuid[])) AND NOT EXISTS (SELECT 1 FROM payment_tokens t WHERE t.liability_agreement_id = la.id)`, [keepOps]);
  await del('agent_versions', `DELETE FROM agent_versions v USING agents a WHERE a.id = v.agent_id AND NOT (a.operator_id = ANY($1::uuid[]))
    AND NOT EXISTS (SELECT 1 FROM liability_agreement_agent_versions x WHERE x.agent_version_id = v.id)`, [keepOps]);
  await del('agents', 'DELETE FROM agents a WHERE NOT EXISTS (SELECT 1 FROM agent_versions v WHERE v.agent_id = a.id)');
  await del('operators', 'DELETE FROM operators o WHERE NOT (id = ANY($1::uuid[])) AND NOT EXISTS (SELECT 1 FROM agents a WHERE a.operator_id = o.id) AND NOT EXISTS (SELECT 1 FROM liability_agreements la WHERE la.operator_id = o.id)', [keepOps]);
  await c.query(`UPDATE operators SET status = 'ACTIVE' WHERE id = ANY($1::uuid[])`, [keepOps]);
  return { deleted: n, keptScorecardRuns: keepRuns.length, agreementNote: retail.note };
}

/** The retail demo's operator, agents, saved PayPal and agreements, archived once as RETAIL (kept as is after that). */
async function archiveRetail(c: pg.PoolClient) {
  const operators = await q(c, 'SELECT * FROM operators WHERE name = $1', [ACME]);
  const opIds = operators.map((o) => o.id);
  const drift = await q(c, 'SELECT id FROM operators WHERE name = $1', [UNCOVERED.operator]);
  const agents = await q(c, `SELECT * FROM agents WHERE operator_id = ANY($1::uuid[]) OR (operator_id = ANY($2::uuid[]) AND name = $3)`, [opIds, drift.map((d) => d.id), UNCOVERED.agent]);
  const agentVersions = await q(c, 'SELECT * FROM agent_versions WHERE agent_id = ANY($1::uuid[])', [agents.map((a) => a.id)]);
  const agreements = await q(c, 'SELECT * FROM liability_agreements WHERE operator_id = ANY($1::uuid[])', [opIds]);
  const coverage = await q(c, 'SELECT * FROM liability_agreement_agent_versions WHERE liability_agreement_id = ANY($1::uuid[])', [agreements.map((a) => a.id)]);
  const tokens = await q(c, `SELECT * FROM payment_tokens WHERE owner_type = 'OPERATOR' AND operator_id = ANY($1::uuid[])`, [opIds]);
  const ids = {
    operators: opIds,
    agents: agents.map((a) => a.id),
    agent_versions: agentVersions.map((v) => v.id),
    liability_agreements: agreements.map((a) => a.id),
    payment_tokens: tokens.map((t) => t.id),
  };
  const have = await q(c, `SELECT 1 FROM demo_archive WHERE label = 'RETAIL' LIMIT 1`);
  if (have.length) return { ids, note: `retail set already archived; removed ${opIds.length} operator(s), ${ids.agent_versions.length} agent version(s) from view` };
  const rows: Record<string, unknown[]> = { operators, agents, agent_versions: agentVersions, liability_agreements: agreements, liability_agreement_agent_versions: coverage, payment_tokens: tokens };
  for (const t of RETAIL_TABLES) await c.query('INSERT INTO demo_archive (label, table_name, rows) VALUES ($1, $2, $3)', ['RETAIL', t, JSON.stringify(rows[t] ?? [])]);
  return { ids, note: `retail set archived as RETAIL (${RETAIL_TABLES.map((t) => `${t} ${rows[t]?.length ?? 0}`).join(', ')}) and removed from view` };
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
    console.log('archive the retail operator and agents as RETAIL and remove them from view, delete every case, order, set of buyer');
    console.log('instructions, agent run, snapshot and recorder entry, reseed the catalogs and the travel agents (Wayfare, Drift),');
    console.log('and keep the latest scorecard run per model.');
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
  console.log(`retail: ${step1.wiped.agreementNote}`);

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
