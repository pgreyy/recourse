import { Router } from 'express';
import { z } from 'zod';
import { config } from '../config';
import { db, tx } from '../shared/db/pool';
import { HttpError, notFound, route } from '../shared/http/errors';
import { uuidParam } from '../shared/http/ids';
import { cents, money, usedUnderAgreement } from '../settlement/exposure';
import {
  AgreementRequest,
  agreementView,
  buildTerms,
  signAcceptance,
  termsHash,
  type AgreementRow,
} from './liability-agreements';
import { finishVaulting, startVaulting, tokenView, type PaymentTokenRow } from './payment-tokens';

export const operators = Router();

type Operator = { id: string; name: string; email: string; status: string; created_at: Date; updated_at: Date };

async function load(id: string): Promise<Operator> {
  const { rows } = await db().query<Operator>('SELECT * FROM operators WHERE id = $1', [id]);
  if (!rows[0]) throw notFound('Operator', id);
  return rows[0];
}

async function acceptedAgreement(operatorId: string): Promise<AgreementRow | undefined> {
  const { rows } = await db().query<AgreementRow>(`SELECT * FROM liability_agreements WHERE operator_id = $1 AND status = 'ACCEPTED'`, [operatorId]);
  return rows[0];
}

async function activeToken(operatorId: string): Promise<PaymentTokenRow | undefined> {
  const { rows } = await db().query<PaymentTokenRow>(
    `SELECT * FROM payment_tokens WHERE operator_id = $1 AND owner_type = 'OPERATOR' AND status = 'ACTIVE'`,
    [operatorId],
  );
  return rows[0];
}

async function view(op: Operator) {
  const base = config.publicBaseUrl();
  const agreement = await acceptedAgreement(op.id);
  const latest = await db().query<{ version: number; status: string }>(
    'SELECT version, status FROM liability_agreements WHERE operator_id = $1 ORDER BY version DESC LIMIT 1',
    [op.id],
  );
  const token = await activeToken(op.id);
  const ready = Boolean(agreement && token && token.liability_agreement_id === agreement.id);
  return {
    id: op.id,
    name: op.name,
    email: op.email,
    status: op.status,
    onboarding: {
      agreement: agreement
        ? { status: 'ACCEPTED', version: agreement.version }
        : latest.rows[0]
          ? { status: latest.rows[0].status, version: latest.rows[0].version }
          : { status: 'NONE' },
      payment_method: token ? { status: token.status, linked_agreement_id: token.liability_agreement_id } : { status: 'NONE' },
      ready,
      next: ready
        ? null
        : !latest.rows[0]
          ? 'POST /operators/:id/liability-agreement'
          : !agreement
            ? 'POST /operators/:id/liability-agreement/:version/accept'
            : 'POST /operators/:id/approve',
    },
    created_at: op.created_at,
    updated_at: op.updated_at,
    links: [
      { rel: 'self', method: 'GET', href: `${base}/operators/${op.id}` },
      { rel: 'liability-agreement', method: 'GET', href: `${base}/operators/${op.id}/liability-agreement` },
      { rel: 'exposure', method: 'GET', href: `${base}/operators/${op.id}/exposure` },
    ],
  };
}

const CreateOperator = z.object({
  name: z.string().trim().min(1).max(200),
  email: z.string().trim().toLowerCase().email(),
});

operators.post(
  '/',
  route(async (req, res) => {
    const body = CreateOperator.parse(req.body);
    const { rows } = await db().query<Operator>('INSERT INTO operators (name, email) VALUES ($1, $2) RETURNING *', [body.name, body.email]);
    res.status(201).json(await view(rows[0]));
  }),
);

operators.get(
  '/:id',
  route(async (req, res) => {
    res.json(await view(await load(uuidParam(req.params.id, 'Operator'))));
  }),
);

// ---------- liability agreement ----------

/** POST /operators/:id/liability-agreement: a new DRAFT version of the terms. */
operators.post(
  '/:id/liability-agreement',
  route(async (req, res) => {
    const op = await load(uuidParam(req.params.id, 'Operator'));
    const body = AgreementRequest.parse(req.body ?? {});
    const row = await tx(async (c) => {
      await c.query('SELECT id FROM operators WHERE id = $1 FOR UPDATE', [op.id]);
      const next = await c.query<{ v: number }>('SELECT COALESCE(MAX(version), 0) + 1 AS v FROM liability_agreements WHERE operator_id = $1', [op.id]);
      const version = next.rows[0].v;
      const terms = await buildTerms(c, op, version, body);
      const { rows } = await c.query<AgreementRow>(
        `INSERT INTO liability_agreements (operator_id, version, terms, terms_hash, per_incident_cap, aggregate_cap, currency, appeal_window_hours)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
        [op.id, version, JSON.stringify(terms), termsHash(terms), body.per_incident_cap.value, body.aggregate_cap.value, body.aggregate_cap.currency, body.appeal_window_hours],
      );
      for (const v of terms.covered_agent_versions) {
        await c.query('INSERT INTO liability_agreement_agent_versions (liability_agreement_id, agent_version_id) VALUES ($1, $2)', [rows[0].id, v.agent_version_id]);
      }
      return rows[0];
    });
    res.status(201).json({
      ...agreementView(row),
      next: `Review the terms, then POST /operators/${op.id}/liability-agreement/${row.version}/accept`,
    });
  }),
);

operators.get(
  '/:id/liability-agreement',
  route(async (req, res) => {
    const op = await load(uuidParam(req.params.id, 'Operator'));
    const { rows } = await db().query<AgreementRow>('SELECT * FROM liability_agreements WHERE operator_id = $1 ORDER BY version DESC', [op.id]);
    const views = rows.map(agreementView);
    res.json({ operator_id: op.id, current: views.find((v) => v.status === 'ACCEPTED') ?? null, versions: views });
  }),
);

const Accept = z.object({
  accepted_by: z.object({ name: z.string().trim().min(1).max(200), email: z.string().trim().toLowerCase().email() }),
});

/** POST /operators/:id/liability-agreement/:version/accept: operator accepts; Recourse signs the acceptance. */
operators.post(
  '/:id/liability-agreement/:version/accept',
  route(async (req, res) => {
    const op = await load(uuidParam(req.params.id, 'Operator'));
    const version = Number(req.params.version);
    const body = Accept.parse(req.body);
    const row = await tx(async (c) => {
      const { rows } = await c.query<AgreementRow>(
        'SELECT * FROM liability_agreements WHERE operator_id = $1 ORDER BY version DESC FOR UPDATE',
        [op.id],
      );
      const target = rows.find((r) => r.version === version);
      if (!target) throw notFound('Liability agreement version', String(req.params.version));
      if (target.status !== 'DRAFT') throw new HttpError(409, 'AGREEMENT_NOT_DRAFT', `Version ${version} is ${target.status}.`);
      if (rows[0].version !== version) throw new HttpError(409, 'NOT_LATEST_VERSION', `Only the latest version (${rows[0].version}) can be accepted.`);
      const at = new Date();
      const signed = signAcceptance(target, body.accepted_by, at);
      await c.query(`UPDATE liability_agreements SET status = 'SUPERSEDED' WHERE operator_id = $1 AND status = 'ACCEPTED'`, [op.id]);
      const updated = await c.query<AgreementRow>(
        `UPDATE liability_agreements SET status = 'ACCEPTED', accepted_at = $2, accepted_by_name = $3, accepted_by_email = $4,
           acceptance_hash = $5, acceptance_signature = $6, signing_key_id = $7
         WHERE id = $1 RETURNING *`,
        [target.id, at, body.accepted_by.name, body.accepted_by.email, signed.acceptanceHash, signed.signature, signed.keyId],
      );
      return updated.rows[0];
    });
    res.json({ ...agreementView(row), next: `POST /operators/${op.id}/approve to save the operator's PayPal under this agreement` });
  }),
);

/** POST /operators/:id/liability-agreement/:version/revoke: no new charges under it; open obligations stay. */
operators.post(
  '/:id/liability-agreement/:version/revoke',
  route(async (req, res) => {
    const op = await load(uuidParam(req.params.id, 'Operator'));
    const version = Number(req.params.version);
    const row = await tx(async (c) => {
      const { rows } = await c.query<AgreementRow>('SELECT * FROM liability_agreements WHERE operator_id = $1 AND version = $2 FOR UPDATE', [op.id, version]);
      if (!rows[0]) throw notFound('Liability agreement version', String(req.params.version));
      if (rows[0].status !== 'ACCEPTED') throw new HttpError(409, 'AGREEMENT_NOT_ACCEPTED', `Version ${version} is ${rows[0].status}.`);
      await c.query(
        `UPDATE payment_tokens SET status = 'REVOKED', revoked_at = now() WHERE liability_agreement_id = $1 AND status IN ('ACTIVE', 'PENDING')`,
        [rows[0].id],
      );
      return (await c.query<AgreementRow>(`UPDATE liability_agreements SET status = 'REVOKED', revoked_at = now() WHERE id = $1 RETURNING *`, [rows[0].id])).rows[0];
    });
    res.json(agreementView(row));
  }),
);

// ---------- operator's saved PayPal (only after the agreement is accepted) ----------

operators.post(
  '/:id/approve',
  route(async (req, res) => {
    const op = await load(uuidParam(req.params.id, 'Operator'));
    const agreement = await acceptedAgreement(op.id);
    if (!agreement) {
      throw new HttpError(409, 'AGREEMENT_NOT_ACCEPTED', 'The operator must accept a liability agreement before a PayPal approve link is issued.', {
        next: `POST /operators/${op.id}/liability-agreement, then POST /operators/${op.id}/liability-agreement/:version/accept`,
      });
    }
    const base = config.publicBaseUrl();
    const started = await startVaulting(
      { owner_type: 'OPERATOR', operator_id: op.id, liability_agreement_id: agreement.id },
      {
        description: `Recourse liability agreement v${agreement.version}: ${op.name}, up to ${agreement.per_incident_cap} ${agreement.currency.trim()} per incident`.slice(0, 127),
        returnUrl: `${base}/operators/${op.id}/vault-return`,
        cancelUrl: `${base}/operators/${op.id}/vault-cancel`,
      },
    );
    res.json({
      operator_id: op.id,
      liability_agreement: { id: agreement.id, version: agreement.version },
      payment_token_id: started.token.id,
      setup_token_id: started.token.setup_token_id,
      approve_url: started.approveUrl,
      paypal_debug_id: started.debugId,
      next: 'Open approve_url as the operator sandbox account.',
    });
  }),
);

operators.get(
  '/:id/vault-return',
  route(async (req, res) => {
    const op = await load(uuidParam(req.params.id, 'Operator'));
    const setupId = typeof req.query.approval_token_id === 'string' ? req.query.approval_token_id : undefined;
    const { rows } = await db().query<PaymentTokenRow>(
      `SELECT * FROM payment_tokens WHERE operator_id = $1 AND owner_type = 'OPERATOR' AND ($2::text IS NULL OR setup_token_id = $2)
       ORDER BY created_at DESC LIMIT 1`,
      [op.id, setupId ?? null],
    );
    const token = rows[0];
    if (!token) throw new HttpError(409, 'NO_PENDING_TOKEN', `No setup token found for this operator; call POST /operators/${op.id}/approve.`);
    if (token.status !== 'ACTIVE') {
      if (token.status !== 'PENDING') throw new HttpError(409, 'TOKEN_NOT_PENDING', `That payment token is ${token.status}.`);
      await tx(async (c) => {
        await c.query(
          `UPDATE payment_tokens SET status = 'REVOKED', revoked_at = now() WHERE operator_id = $1 AND owner_type = 'OPERATOR' AND status = 'ACTIVE'`,
          [op.id],
        );
        await finishVaulting(c, token.id);
      });
    }
    res.json(await view(op));
  }),
);

operators.get(
  '/:id/vault-cancel',
  route(async (req, res) => {
    const op = await load(uuidParam(req.params.id, 'Operator'));
    await db().query(`UPDATE payment_tokens SET status = 'FAILED' WHERE operator_id = $1 AND status = 'PENDING'`, [op.id]);
    res.json({ operator_id: op.id, message: 'Approval was cancelled at PayPal. Call approve again for a new link.' });
  }),
);

/** GET /operators/:id/exposure: caps from the accepted agreement, used and remaining. */
operators.get(
  '/:id/exposure',
  route(async (req, res) => {
    const op = await load(uuidParam(req.params.id, 'Operator'));
    const agreement = await acceptedAgreement(op.id);
    const token = await activeToken(op.id);
    if (!agreement) {
      return res.json({ operator_id: op.id, agreement: null, message: 'No accepted liability agreement: the operator has no exposure and no agent is covered.' });
    }
    const ccy = agreement.currency.trim();
    const used = await usedUnderAgreement(agreement.id);
    const aggregate = cents(agreement.aggregate_cap);
    const remaining = Math.max(0, aggregate - used.usedCents);
    res.json({
      operator_id: op.id,
      agreement: { id: agreement.id, version: agreement.version, accepted_at: agreement.accepted_at, appeal_window_hours: agreement.appeal_window_hours },
      per_incident_cap: money(cents(agreement.per_incident_cap), ccy),
      aggregate_cap: money(aggregate, ccy),
      used: money(used.usedCents, ccy),
      remaining: money(remaining, ccy),
      largest_next_incident: money(Math.min(remaining, cents(agreement.per_incident_cap)), ccy),
      incidents_settled: used.incidents,
      payment_method: token ? { ...tokenView(token), linked_to_current_agreement: token.liability_agreement_id === agreement.id } : null,
    });
  }),
);
