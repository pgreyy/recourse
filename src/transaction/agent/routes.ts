import { Router } from 'express';
import { z } from 'zod';
import { db } from '../../shared/db/pool';
import { notFound, route } from '../../shared/http/errors';
import { uuidParam } from '../../shared/http/ids';
import { runAgent } from './runner';

export const agentRoutes = Router();

const RunBody = z.object({
  mandate_id: z.string().uuid(),
  agent_version_id: z.string().uuid(),
  /** Shop and preview checkout without anchoring or charging. Works on a DRAFT mandate too. */
  dry_run: z.boolean().optional(),
  /** Pin the run to one provider in the model chain (e.g. to rehearse on OpenAI). */
  provider: z.enum(['gemini', 'openai', 'anthropic']).optional(),
  /** Answer 202 as soon as the run has started (for the live timeline); poll GET /console/runs/:id. */
  async: z.boolean().optional(),
});

/** POST /agent/run { mandate_id, agent_version_id, dry_run?, provider? } */
agentRoutes.post(
  '/run',
  route(async (req, res) => {
    const body = RunBody.parse(req.body);
    if (!body.async) return res.json(await runAgent(body.mandate_id, body.agent_version_id, { dryRun: body.dry_run, provider: body.provider }));
    let started!: (r: { run_id: string; case_ref: string }) => void;
    const startedP = new Promise<{ run_id: string; case_ref: string }>((resolve) => (started = resolve));
    const done = runAgent(body.mandate_id, body.agent_version_id, { dryRun: body.dry_run, provider: body.provider, onStarted: started });
    // Errors before the run starts (mandate not active, unknown agent) answer this request; later ones are in the recorder.
    done.catch((e) => console.log(`[agent] async run failed: ${(e as Error).message}`));
    const r = await Promise.race([startedP, done.then(() => null)]);
    if (!r) return res.json(await done);
    res.status(202).json({ ...r, poll: `/console/runs/${r.run_id}` });
  }),
);

agentRoutes.get(
  '/runs/:id',
  route(async (req, res) => {
    const id = uuidParam(req.params.id, 'Agent run');
    const r = await db().query('SELECT * FROM agent_runs WHERE id = $1', [id]);
    if (!r.rows[0]) throw notFound('Agent run', id);
    res.json(r.rows[0]);
  }),
);

/** GET /agent/versions: the seeded versions, for picking an agent_version_id. */
agentRoutes.get(
  '/versions',
  route(async (_req, res) => {
    const r = await db().query(
      `SELECT v.id AS agent_version_id, a.name, v.version, v.model_config->>'profile' AS profile, o.name AS operator
       FROM agent_versions v JOIN agents a ON a.id = v.agent_id JOIN operators o ON o.id = a.operator_id
       WHERE v.instructions IS NOT NULL ORDER BY a.name, v.version`,
    );
    res.json(r.rows);
  }),
);
