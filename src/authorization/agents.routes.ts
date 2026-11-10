import { Router } from 'express';
import { z } from 'zod';
import { db } from '../shared/db/pool';
import { HttpError, notFound, route } from '../shared/http/errors';
import { uuidParam } from '../shared/http/ids';

export const agents = Router();

async function view(agentId: string) {
  const { rows } = await db().query(
    `SELECT a.*, o.name AS operator_name FROM agents a JOIN operators o ON o.id = a.operator_id WHERE a.id = $1`,
    [agentId],
  );
  if (!rows[0]) throw notFound('Agent', agentId);
  const versions = await db().query('SELECT id, version, status, created_at FROM agent_versions WHERE agent_id = $1 ORDER BY created_at', [agentId]);
  const a = rows[0];
  return {
    id: a.id,
    name: a.name,
    status: a.status,
    operator: { id: a.operator_id, name: a.operator_name },
    versions: versions.rows,
    created_at: a.created_at,
  };
}

const CreateAgent = z.object({ operator_id: z.string().uuid(), name: z.string().trim().min(1).max(200) });

/** POST /agents { operator_id, name } */
agents.post(
  '/',
  route(async (req, res) => {
    const body = CreateAgent.parse(req.body);
    const op = await db().query('SELECT id FROM operators WHERE id = $1', [body.operator_id]);
    if (!op.rows[0]) throw new HttpError(404, 'RESOURCE_NOT_FOUND', `Operator ${body.operator_id} not found`);
    const { rows } = await db().query<{ id: string }>('INSERT INTO agents (operator_id, name) VALUES ($1, $2) RETURNING id', [body.operator_id, body.name]);
    res.status(201).json(await view(rows[0].id));
  }),
);

agents.get(
  '/:id',
  route(async (req, res) => {
    res.json(await view(uuidParam(req.params.id, 'Agent')));
  }),
);

const CreateVersion = z.object({ version: z.string().trim().min(1).max(50) });

/** POST /agents/:id/versions { version }: liability and rulings attach to a specific version. */
agents.post(
  '/:id/versions',
  route(async (req, res) => {
    const id = uuidParam(req.params.id, 'Agent');
    const body = CreateVersion.parse(req.body);
    await view(id); // 404 if the agent doesn't exist
    const { rows } = await db().query(
      'INSERT INTO agent_versions (agent_id, version) VALUES ($1, $2) RETURNING id, agent_id, version, status, created_at',
      [id, body.version],
    );
    res.status(201).json({
      ...rows[0],
      note: 'Existing liability agreements do not cover a new version. Create and accept a new agreement version to cover it.',
    });
  }),
);
