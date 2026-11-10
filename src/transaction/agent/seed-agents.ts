// npm run seed:agents [-- --retail]   (without --retail: the travel demo only)
//  - "Acme Shopper" v1.3 (fast) and v2.0 (careful) under operator "Acme Shopping Agents" (the onboarded
//    one if it exists). If Acme's ACCEPTED liability agreement does not cover both versions, a new
//    agreement version covering every active Acme agent version is created and accepted on Acme's
//    behalf (accepted_by "Acme Ops (demo seed)"); the acceptance is signed like any other.
//  - "Drift Shopper" v1.0 and "Drift Booker" v1.0 under operator "Drift Commerce", which never signs an agreement.
//  - "Wayfare Booker" v1.3 (fast) and v2.0 (careful) under operator "Wayfare Agents", the travel demo. If Wayfare
//    has no agreement yet, a DRAFT is created (Tidewell Stays, hotel stays, 400.00 per incident, 1,000.00 total,
//    72 h appeal): the operator accepts it on the operator screen, as a person would.
// Safe to rerun.
import type pg from 'pg';
import { AgreementRequest, buildTerms, signAcceptance, termsHash, type AgreementRow } from '../../authorization/liability-agreements';
import { closeDb, tx } from '../../shared/db/pool';
import { AGENT_NAME, AGENT_VERSIONS, MODEL_CONFIG, TRAVEL_AGENT_NAME, TRAVEL_AGENT_VERSIONS, TRAVEL_OPERATOR, UNCOVERED, UNCOVERED_TRAVEL } from './versions';
import { TRAVEL_MERCHANT } from '../catalog';

const OPERATOR = 'Acme Shopping Agents';

async function upsertAgentVersion(c: pg.PoolClient, operatorId: string, agentName: string, version: string, instructions: string, profile: string) {
  const agent = await c.query<{ id: string }>(
    `INSERT INTO agents (operator_id, name) VALUES ($1, $2) ON CONFLICT (operator_id, name) DO UPDATE SET name = EXCLUDED.name RETURNING id`,
    [operatorId, agentName],
  );
  const v = await c.query<{ id: string }>(
    `INSERT INTO agent_versions (agent_id, version, instructions, model_config) VALUES ($1, $2, $3, $4)
     ON CONFLICT (agent_id, version) DO UPDATE SET instructions = EXCLUDED.instructions, model_config = EXCLUDED.model_config
     RETURNING id`,
    [agent.rows[0].id, version, instructions, JSON.stringify({ ...MODEL_CONFIG, profile })],
  );
  return { agentId: agent.rows[0].id, versionId: v.rows[0].id };
}

async function operatorByName(c: pg.PoolClient, name: string, email: string) {
  const op = await c.query<{ id: string; name: string; email: string }>(
    `SELECT o.id, o.name, o.email FROM operators o
     LEFT JOIN payment_tokens t ON t.operator_id = o.id AND t.owner_type = 'OPERATOR' AND t.status = 'ACTIVE'
     WHERE o.name = $1 ORDER BY (t.id IS NOT NULL) DESC, o.created_at LIMIT 1`,
    [name],
  );
  return op.rows[0] ?? (await c.query<{ id: string; name: string; email: string }>('INSERT INTO operators (name, email) VALUES ($1, $2) RETURNING id, name, email', [name, email])).rows[0];
}

/** Make sure Acme's accepted agreement covers the given versions; otherwise create and accept a new version. */
async function ensureCoverage(c: pg.PoolClient, op: { id: string; name: string; email: string }, versionIds: string[]) {
  const covered = await c.query<{ n: string }>(
    `SELECT COUNT(DISTINCT x.agent_version_id) AS n FROM liability_agreements la
     JOIN liability_agreement_agent_versions x ON x.liability_agreement_id = la.id
     WHERE la.operator_id = $1 AND la.status = 'ACCEPTED' AND x.agent_version_id = ANY($2::uuid[])`,
    [op.id, versionIds],
  );
  if (Number(covered.rows[0].n) === versionIds.length) return 'already covered';
  const next = await c.query<{ v: number }>('SELECT COALESCE(MAX(version), 0) + 1 AS v FROM liability_agreements WHERE operator_id = $1', [op.id]);
  const req = AgreementRequest.parse({});
  const terms = await buildTerms(c, op, next.rows[0].v, req);
  const ins = await c.query<AgreementRow>(
    `INSERT INTO liability_agreements (operator_id, version, terms, terms_hash, per_incident_cap, aggregate_cap, currency, appeal_window_hours)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
    [op.id, next.rows[0].v, JSON.stringify(terms), termsHash(terms), req.per_incident_cap.value, req.aggregate_cap.value, req.aggregate_cap.currency, req.appeal_window_hours],
  );
  for (const v of terms.covered_agent_versions) {
    await c.query('INSERT INTO liability_agreement_agent_versions (liability_agreement_id, agent_version_id) VALUES ($1, $2)', [ins.rows[0].id, v.agent_version_id]);
  }
  const by = { name: 'Acme Ops (demo seed)', email: op.email };
  const at = new Date();
  const signed = signAcceptance(ins.rows[0], by, at);
  await c.query(`UPDATE liability_agreements SET status = 'SUPERSEDED' WHERE operator_id = $1 AND status = 'ACCEPTED'`, [op.id]);
  await c.query(
    `UPDATE liability_agreements SET status = 'ACCEPTED', accepted_at = $2, accepted_by_name = $3, accepted_by_email = $4,
       acceptance_hash = $5, acceptance_signature = $6, signing_key_id = $7 WHERE id = $1`,
    [ins.rows[0].id, at, by.name, by.email, signed.acceptanceHash, signed.signature, signed.keyId],
  );
  return `agreement v${next.rows[0].v} created and accepted, covering ${terms.covered_agent_versions.map((v) => `${v.agent_name} ${v.version}`).join(', ')}`;
}

/** Wayfare's agreement: left as a DRAFT for the operator to accept on the operator screen. */
async function ensureTravelDraft(c: pg.PoolClient, op: { id: string; name: string; email: string }) {
  const existing = await c.query<{ version: number; status: string }>(
    `SELECT version, status FROM liability_agreements WHERE operator_id = $1 AND status IN ('ACCEPTED', 'DRAFT') ORDER BY version DESC LIMIT 1`,
    [op.id],
  );
  if (existing.rows[0]) return `v${existing.rows[0].version} already ${existing.rows[0].status.toLowerCase()}`;
  const next = await c.query<{ v: number }>('SELECT COALESCE(MAX(version), 0) + 1 AS v FROM liability_agreements WHERE operator_id = $1', [op.id]);
  const req = AgreementRequest.parse({
    merchant_ids: [TRAVEL_MERCHANT.id],
    categories: ['hotel stays'],
    per_incident_cap: { value: '400.00', currency: 'USD' },
    aggregate_cap: { value: '1000.00', currency: 'USD' },
    appeal_window_hours: 72,
  });
  const terms = await buildTerms(c, op, next.rows[0].v, req);
  const ins = await c.query<{ id: string }>(
    `INSERT INTO liability_agreements (operator_id, version, terms, terms_hash, per_incident_cap, aggregate_cap, currency, appeal_window_hours)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
    [op.id, next.rows[0].v, JSON.stringify(terms), termsHash(terms), req.per_incident_cap.value, req.aggregate_cap.value, req.aggregate_cap.currency, req.appeal_window_hours],
  );
  for (const v of terms.covered_agent_versions) {
    await c.query('INSERT INTO liability_agreement_agent_versions (liability_agreement_id, agent_version_id) VALUES ($1, $2)', [ins.rows[0].id, v.agent_version_id]);
  }
  return `v${next.rows[0].v} created as a DRAFT, covering ${terms.covered_agent_versions.map((v) => `${v.agent_name} ${v.version}`).join(', ')}; accept it on the operator screen`;
}

async function main(): Promise<void> {
  // The retail agents (Acme, Drift Shopper) only with --retail: the demo is travel; retail lives in the archive.
  const retailToo = process.argv.includes('--retail');
  const out = await tx(async (c) => {
    if (!retailToo) {
      const drift = await operatorByName(c, UNCOVERED.operator, 'drift-operator@example.com');
      const dtv = await upsertAgentVersion(c, drift.id, UNCOVERED_TRAVEL.agent, UNCOVERED_TRAVEL.version, UNCOVERED_TRAVEL.instructions, 'uncovered');
      const wayfare = await operatorByName(c, TRAVEL_OPERATOR, process.env.OPERATOR_EMAIL ?? 'operator@example.com');
      const wversions: Array<{ version: string; id: string }> = [];
      for (const v of TRAVEL_AGENT_VERSIONS) {
        const r = await upsertAgentVersion(c, wayfare.id, TRAVEL_AGENT_NAME, v.version, v.instructions, v.profile);
        wversions.push({ version: v.version, id: r.versionId });
      }
      const wdraft = await ensureTravelDraft(c, wayfare);
      return { travelOnly: true as const, drift, dtv, wayfare, wversions, wdraft };
    }
    const acme = await operatorByName(c, OPERATOR, process.env.OPERATOR_EMAIL ?? 'operator@example.com');
    const versions: Array<{ version: string; id: string }> = [];
    let agentId = '';
    for (const v of AGENT_VERSIONS) {
      const r = await upsertAgentVersion(c, acme.id, AGENT_NAME, v.version, v.instructions, v.profile);
      agentId = r.agentId;
      versions.push({ version: v.version, id: r.versionId });
    }
    const coverage = await ensureCoverage(c, acme, versions.map((v) => v.id));
    const drift = await operatorByName(c, UNCOVERED.operator, 'drift-operator@example.com');
    const dv = await upsertAgentVersion(c, drift.id, UNCOVERED.agent, UNCOVERED.version, UNCOVERED.instructions, 'uncovered');
    const dtv = await upsertAgentVersion(c, drift.id, UNCOVERED_TRAVEL.agent, UNCOVERED_TRAVEL.version, UNCOVERED_TRAVEL.instructions, 'uncovered');
    const wayfare = await operatorByName(c, TRAVEL_OPERATOR, process.env.OPERATOR_EMAIL ?? 'operator@example.com');
    const wversions: Array<{ version: string; id: string }> = [];
    for (const v of TRAVEL_AGENT_VERSIONS) {
      const r = await upsertAgentVersion(c, wayfare.id, TRAVEL_AGENT_NAME, v.version, v.instructions, v.profile);
      wversions.push({ version: v.version, id: r.versionId });
    }
    const wdraft = await ensureTravelDraft(c, wayfare);
    return { travelOnly: false as const, acme, agentId, versions, coverage, drift, dv, dtv, wayfare, wversions, wdraft };
  });
  if (out.travelOnly) {
    console.log(`Operator ${UNCOVERED.operator} (no agreement): ${out.drift.id}`);
    console.log(`  ${UNCOVERED_TRAVEL.agent} v${UNCOVERED_TRAVEL.version}: ${out.dtv.versionId}`);
    console.log(`Operator ${TRAVEL_OPERATOR}: ${out.wayfare.id}`);
    for (const v of out.wversions) console.log(`  ${TRAVEL_AGENT_NAME} v${v.version}: ${v.id}`);
    console.log(`Agreement: ${out.wdraft}`);
    return;
  }
  console.log(`Operator ${OPERATOR}: ${out.acme.id}`);
  console.log(`Agent ${AGENT_NAME}: ${out.agentId}`);
  for (const v of out.versions) console.log(`  v${v.version}: ${v.id}`);
  console.log(`Coverage: ${out.coverage}`);
  console.log(`Operator ${UNCOVERED.operator} (no agreement): ${out.drift.id}`);
  console.log(`  ${UNCOVERED.agent} v${UNCOVERED.version}: ${out.dv.versionId}`);
  console.log(`  ${UNCOVERED_TRAVEL.agent} v${UNCOVERED_TRAVEL.version}: ${out.dtv.versionId}`);
  console.log(`Operator ${TRAVEL_OPERATOR}: ${out.wayfare.id}`);
  for (const v of out.wversions) console.log(`  ${TRAVEL_AGENT_NAME} v${v.version}: ${v.id}`);
  console.log(`Agreement: ${out.wdraft}`);
}

main()
  .catch((e) => {
    console.error(e.message);
    process.exitCode = 1;
  })
  .finally(() => closeDb());
