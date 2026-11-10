import { Router } from 'express';
import { db } from '../shared/db/pool';
import { HttpError, route } from '../shared/http/errors';
import { PROMPT_VERSION_HASH } from './assessor';
import { storeAssessment } from './cases';
import { buildFixtureMaterial, readFixtures } from './fixtures';
import { runPipeline } from './pipeline';

/**
 * Scorecard: the labelled fixtures in data/scorecard-cases.json run once through the full pipeline
 * (code checks, then the model where the evidence holds, then validation). Product data, not a test
 * suite: it tells you how a model + prompt version behaves before you trust it with rulings.
 */
let running: { started_at: Date; done: number; total: number } | null = null;

async function run() {
  const fx = readFixtures();
  const started = new Date();
  running = { started_at: started, done: 0, total: fx.cases.length };
  const runId = (await db().query<{ id: string }>('SELECT gen_random_uuid() AS id')).rows[0].id;
  const results: Array<Record<string, unknown>> = [];
  const models = new Set<string>();
  let aiCalls = 0;
  try {
    for (const f of fx.cases) {
      let row: Record<string, unknown>;
      try {
        const r = await runPipeline(buildFixtureMaterial(f));
        if (r.ai_called) aiCalls++;
        if (r.model) models.add(`${r.model.provider}/${r.model.id}`);
        await storeAssessment({ result: r, scorecardRunId: runId, fixtureId: f.id });
        row = {
          id: f.id,
          domain: f.domain,
          category: f.category,
          expected: f.expected,
          got: r.final_verdict,
          model_verdict: r.ai_output?.verdict ?? null,
          correct: r.final_verdict === f.expected,
          validation_problems: r.validation.problems,
          injection_flags: r.injection_flags.length,
          requires_human_review: r.requires_human_review,
          model: r.model ? `${r.model.provider}/${r.model.id}` : null,
        };
      } catch (e) {
        row = { id: f.id, domain: f.domain, category: f.category, expected: f.expected, got: 'ERROR', correct: false, error: (e as Error).message.slice(0, 200) };
      }
      results.push(row);
      running.done++;
      console.log(`scorecard ${f.id}: expected ${f.expected}, got ${row.got}${row.correct ? '' : '  <-- MISS'}`);
    }
    const total = results.length;
    const correct = results.filter((r) => r.correct).length;
    const notAgentFault = results.filter((r) => r.expected !== 'AGENT_FAULT');
    const falseAgentFault = notAgentFault.filter((r) => r.got === 'AGENT_FAULT').length;
    const inconclusive = results.filter((r) => r.got === 'INCONCLUSIVE').length;
    const modelList = [...models];
    await db().query(
      `INSERT INTO scorecard_runs (id, model_provider, model_id, prompt_version_hash, fixtures_version, cases_total, correct, accuracy, false_agent_fault_rate,
         inconclusive_rate, ai_calls, results, started_at, finished_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, now())`,
      [
        runId,
        modelList.map((m) => m.split('/')[0]).filter((v, i, a) => a.indexOf(v) === i).join(',') || null,
        modelList.map((m) => m.split('/')[1]).join(',') || null,
        PROMPT_VERSION_HASH,
        fx.version,
        total,
        correct,
        total ? correct / total : 0,
        notAgentFault.length ? falseAgentFault / notAgentFault.length : 0,
        total ? inconclusive / total : 0,
        aiCalls,
        JSON.stringify(results),
        started,
      ],
    );
  } finally {
    running = null;
  }
}

export const scorecard = Router();

/** POST /scorecard/run: starts one run in the background (about one model call per fixture). */
scorecard.post(
  '/run',
  route(async (_req, res) => {
    if (running) throw new HttpError(409, 'ALREADY_RUNNING', `A scorecard run is in progress (${running.done}/${running.total}).`);
    run().catch((e) => console.error('scorecard run failed:', (e as Error).message));
    res.status(202).json({ status: 'RUNNING', fixtures: readFixtures().cases.length, prompt_version_hash: PROMPT_VERSION_HASH, poll: 'GET /scorecard' });
  }),
);

/** GET /scorecard: the latest runs (and progress if one is running). */
scorecard.get(
  '/',
  route(async (_req, res) => {
    const { rows } = await db().query(
      `SELECT id, model_provider, model_id, prompt_version_hash, fixtures_version, cases_total, correct, accuracy::float, false_agent_fault_rate::float,
              inconclusive_rate::float, ai_calls, results, started_at, finished_at
       FROM scorecard_runs ORDER BY finished_at DESC LIMIT 10`,
    );
    res.json({ running, runs: rows });
  }),
);
