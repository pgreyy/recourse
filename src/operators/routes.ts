import { Router } from 'express';
import { z } from 'zod';
import { config } from '../config';
import { db } from '../db/pool';
import { HttpError, notFound, route } from '../http/errors';
import { uuidParam } from '../http/ids';
import { approveLink, createPaymentToken, createPaypalSetupToken } from '../paypal/vault';
import { expectOk } from '../paypal/types';

export const operators = Router();

const CreateOperator = z.object({
  name: z.string().trim().min(1).max(200),
  email: z.string().trim().toLowerCase().email(),
  liability_limit: z
    .object({
      value: z.string().regex(/^\d+(\.\d{1,2})?$/).refine((v) => Number(v) > 0, 'must be more than 0'),
      currency: z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/),
    })
    .optional(),
});

type Row = {
  id: string;
  name: string;
  email: string;
  status: string;
  setup_token_id: string | null;
  paypal_customer_id: string | null;
  operator_vault_id: string | null;
  vaulted_at: Date | null;
  liability_limit_value: string;
  liability_limit_currency: string;
  created_at: Date;
  updated_at: Date;
};

async function load(id: string): Promise<Row> {
  const { rows } = await db().query<Row>('SELECT * FROM operators WHERE id = $1', [id]);
  if (!rows[0]) throw notFound('Operator', id);
  return rows[0];
}

function view(row: Row) {
  const base = config.publicBaseUrl();
  const links = [{ rel: 'self', method: 'GET', href: `${base}/operators/${row.id}` }];
  if (row.status === 'PENDING_VAULT' || row.status === 'PENDING_APPROVAL') {
    links.push({ rel: 'approve', method: 'POST', href: `${base}/operators/${row.id}/approve` });
  }
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    status: row.status,
    liability_limit: { value: row.liability_limit_value, currency: row.liability_limit_currency.trim() },
    setup_token_id: row.setup_token_id,
    operator_vault_id: row.operator_vault_id,
    paypal_customer_id: row.paypal_customer_id,
    vaulted_at: row.vaulted_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
    links,
  };
}

/** POST /operators { name, email, liability_limit? }: default liability limit 200.00 USD. */
operators.post(
  '/',
  route(async (req, res) => {
    const body = CreateOperator.parse(req.body);
    const { rows } = await db().query<Row>(
      `INSERT INTO operators (name, email, liability_limit_value, liability_limit_currency)
       VALUES ($1, $2, COALESCE($3::numeric, 200.00), COALESCE($4, 'USD')) RETURNING *`,
      [body.name, body.email, body.liability_limit?.value ?? null, body.liability_limit?.currency ?? null],
    );
    res.status(201).json(view(rows[0]));
  }),
);

operators.get(
  '/:id',
  route(async (req, res) => {
    res.json(view(await load(uuidParam(req.params.id, 'Operator'))));
  }),
);

/** POST /operators/:id/approve: vault setup token for the operator's PayPal; returns the approve link. */
operators.post(
  '/:id/approve',
  route(async (req, res) => {
    const row = await load(uuidParam(req.params.id, 'Operator'));
    if (row.status === 'ACTIVE') throw new HttpError(409, 'ALREADY_ACTIVE', 'Operator already has a vaulted payment method.');
    const base = config.publicBaseUrl();
    const setup = expectOk(
      'create setup token',
      await createPaypalSetupToken({
        description: `Recourse: ${row.name} pre-authorizes agent liability payments up to ${row.liability_limit_value} ${row.liability_limit_currency.trim()}`.slice(0, 127),
        returnUrl: `${base}/operators/${row.id}/vault-return`,
        cancelUrl: `${base}/operators/${row.id}/vault-cancel`,
      }),
    );
    await db().query(
      `UPDATE operators SET status = 'PENDING_APPROVAL', setup_token_id = $2, paypal_customer_id = $3, updated_at = now() WHERE id = $1`,
      [row.id, setup.body.id, setup.body.customer?.id ?? null],
    );
    res.json({
      operator_id: row.id,
      status: 'PENDING_APPROVAL',
      setup_token_id: setup.body.id,
      approve_url: approveLink(setup.body),
      paypal_debug_id: setup.debugId,
      next: 'Open approve_url and log in as the operator sandbox account.',
    });
  }),
);

/** PayPal redirects here after the operator approves: setup token -> operator_vault_id, ACTIVE. */
operators.get(
  '/:id/vault-return',
  route(async (req, res) => {
    const row = await load(uuidParam(req.params.id, 'Operator'));
    if (row.status === 'ACTIVE') return res.json(view(row));
    if (row.status !== 'PENDING_APPROVAL' || !row.setup_token_id) {
      throw new HttpError(409, 'OPERATOR_NOT_PENDING', `Operator is ${row.status}; call POST /operators/${row.id}/approve first.`);
    }
    const returned = typeof req.query.approval_token_id === 'string' ? req.query.approval_token_id : undefined;
    if (returned && returned !== row.setup_token_id) {
      throw new HttpError(400, 'TOKEN_MISMATCH', 'approval_token_id does not match the setup token issued for this operator.');
    }
    const token = expectOk('create payment token', await createPaymentToken(row.setup_token_id));
    const { rows } = await db().query<Row>(
      `UPDATE operators SET status = 'ACTIVE', operator_vault_id = $2, paypal_customer_id = COALESCE($3, paypal_customer_id),
         vaulted_at = now(), updated_at = now() WHERE id = $1 RETURNING *`,
      [row.id, token.body.id, token.body.customer?.id ?? null],
    );
    res.json(view(rows[0]));
  }),
);

operators.get(
  '/:id/vault-cancel',
  route(async (req, res) => {
    const row = await load(uuidParam(req.params.id, 'Operator'));
    if (row.status === 'PENDING_APPROVAL') {
      await db().query(`UPDATE operators SET status = 'PENDING_VAULT', updated_at = now() WHERE id = $1`, [row.id]);
    }
    res.json({ operator_id: row.id, status: row.status === 'PENDING_APPROVAL' ? 'PENDING_VAULT' : row.status, message: 'Approval was cancelled at PayPal.' });
  }),
);
