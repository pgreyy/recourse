import { Router } from 'express';
import { z } from 'zod';
import { db } from '../db/pool';
import { HttpError, notFound, route } from '../http/errors';
import { uuidParam } from '../http/ids';

export const agents = Router();

const CreateAgent = z.object({
  operator_id: z.string().uuid(),
  name: z.string().trim().min(1).max(200),
  version: z.string().trim().min(1).max(50),
});

const SELECT = `SELECT a.*, o.name AS operator_name, o.status AS operator_status
                FROM agents a JOIN operators o ON o.id = a.operator_id`;

function view(r: any) {
  return {
    id: r.id,
    name: r.name,
    version: r.version,
    status: r.status,
    operator: { id: r.operator_id, name: r.operator_name, status: r.operator_status },
    created_at: r.created_at,
  };
}

/** POST /agents { operator_id, name, version } */
agents.post(
  '/',
  route(async (req, res) => {
    const body = CreateAgent.parse(req.body);
    const op = await db().query('SELECT id FROM operators WHERE id = $1', [body.operator_id]);
    if (!op.rows[0]) throw new HttpError(404, 'RESOURCE_NOT_FOUND', `Operator ${body.operator_id} not found`);
    const { rows } = await db().query<{ id: string }>(
      'INSERT INTO agents (operator_id, name, version) VALUES ($1, $2, $3) RETURNING id',
      [body.operator_id, body.name, body.version],
    );
    const full = await db().query(`${SELECT} WHERE a.id = $1`, [rows[0].id]);
    res.status(201).json(view(full.rows[0]));
  }),
);

agents.get(
  '/:id',
  route(async (req, res) => {
    const id = uuidParam(req.params.id, 'Agent');
    const { rows } = await db().query(`${SELECT} WHERE a.id = $1`, [id]);
    if (!rows[0]) throw notFound('Agent', id);
    res.json(view(rows[0]));
  }),
);
