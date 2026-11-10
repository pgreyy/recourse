import { Router } from 'express';
import { z } from 'zod';
import { config } from '../config';
import { loadSigner } from '../crypto/signing';
import { db } from '../db/pool';
import { HttpError, notFound, route, zodDetails } from '../http/errors';
import { uuidParam } from '../http/ids';
import { approveLink, createPaymentToken, createPaypalSetupToken } from '../paypal/vault';
import { expectOk } from '../paypal/types';
import { checkSignature, signMandate, type MandateRow } from './document';
import { parseMandateText } from './parse';
import { MandateSpec } from './spec';

export const mandates = Router();

const CreateMandate = z.object({
  buyer_email: z.string().trim().toLowerCase().email(),
  text: z.string().trim().min(3).max(2000),
});

type Row = MandateRow & {
  buyer_id: string;
  agent_id: string | null;
  status: string;
  llm_provider: string | null;
  llm_model: string | null;
  setup_token_id: string | null;
  paypal_customer_id: string | null;
  created_at: Date;
  updated_at: Date;
};

async function load(id: string): Promise<Row> {
  const { rows } = await db().query<Row>(
    `SELECT m.*, b.email AS buyer_email FROM mandates m JOIN buyers b ON b.id = m.buyer_id WHERE m.id = $1`,
    [id],
  );
  if (!rows[0]) throw notFound('Mandate', id);
  return rows[0];
}

function view(row: Row) {
  const base = config.publicBaseUrl();
  const sig = checkSignature(row);
  const links = [{ rel: 'self', method: 'GET', href: `${base}/mandates/${row.id}` }];
  if (row.status === 'DRAFT' || row.status === 'PENDING_APPROVAL') {
    links.push({ rel: 'approve', method: 'POST', href: `${base}/mandates/${row.id}/approve` });
  }
  return {
    id: row.id,
    status: row.status,
    buyer_email: row.buyer_email,
    source_text: row.source_text,
    spec: row.spec,
    agent_id: row.agent_id,
    llm: { provider: row.llm_provider, model: row.llm_model },
    setup_token_id: row.setup_token_id,
    vault_id: row.vault_id,
    paypal_customer_id: row.paypal_customer_id,
    signed_at: row.signed_at,
    signing_key_id: row.signing_key_id,
    mandate_hash: row.mandate_hash?.trim() ?? null,
    signature: row.signature,
    ...sig,
    created_at: row.created_at,
    updated_at: row.updated_at,
    links,
  };
}

/** POST /mandates { buyer_email, text }: LLM turns the text into a strict spec, saved as DRAFT. */
mandates.post(
  '/',
  route(async (req, res) => {
    const body = CreateMandate.parse(req.body);
    const { draft, provider, modelId } = await parseMandateText(body.text);
    const spec = MandateSpec.safeParse(draft);
    if (!spec.success) {
      throw new HttpError(422, 'MANDATE_UNCLEAR', 'The instruction could not be turned into a complete mandate. Fix the text and try again.', {
        issues: zodDetails(spec.error),
        llm_draft: draft,
      });
    }
    const buyer = await db().query<{ id: string }>(
      `INSERT INTO buyers (email) VALUES ($1)
       ON CONFLICT (email) DO UPDATE SET updated_at = now() RETURNING id`,
      [body.buyer_email],
    );
    const { rows } = await db().query<{ id: string }>(
      `INSERT INTO mandates (buyer_id, source_text, spec, llm_provider, llm_model)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [buyer.rows[0].id, body.text, JSON.stringify(spec.data), provider, modelId],
    );
    res.status(201).json(view(await load(rows[0].id)));
  }),
);

mandates.get(
  '/:id',
  route(async (req, res) => {
    res.json(view(await load(uuidParam(req.params.id, 'Mandate'))));
  }),
);

/** POST /mandates/:id/approve: PayPal vault setup token for the buyer; returns the approve link. */
mandates.post(
  '/:id/approve',
  route(async (req, res) => {
    const row = await load(uuidParam(req.params.id, 'Mandate'));
    if (row.status !== 'DRAFT' && row.status !== 'PENDING_APPROVAL') {
      throw new HttpError(409, 'MANDATE_NOT_APPROVABLE', `Mandate is ${row.status}; only DRAFT or PENDING_APPROVAL can be approved.`);
    }
    loadSigner(); // fail before PayPal if the signing key is missing
    const spec = row.spec as MandateSpec;
    const base = config.publicBaseUrl();
    const setup = expectOk(
      'create setup token',
      await createPaypalSetupToken({
        description: `Recourse mandate: ${spec.category}, up to ${spec.max_total.value} ${spec.max_total.currency}`.slice(0, 127),
        returnUrl: `${base}/mandates/${row.id}/vault-return`,
        cancelUrl: `${base}/mandates/${row.id}/vault-cancel`,
      }),
    );
    await db().query(
      `UPDATE mandates SET status = 'PENDING_APPROVAL', setup_token_id = $2, paypal_customer_id = $3, updated_at = now() WHERE id = $1`,
      [row.id, setup.body.id, setup.body.customer?.id ?? null],
    );
    res.json({
      mandate_id: row.id,
      status: 'PENDING_APPROVAL',
      setup_token_id: setup.body.id,
      approve_url: approveLink(setup.body),
      paypal_debug_id: setup.debugId,
      next: 'Open approve_url and log in as the buyer sandbox account. PayPal then redirects to the vault-return link, which activates the mandate.',
    });
  }),
);

/** PayPal redirects here after the buyer approves: setup token -> vault_id, sign, ACTIVE. */
mandates.get(
  '/:id/vault-return',
  route(async (req, res) => {
    const row = await load(uuidParam(req.params.id, 'Mandate'));
    if (row.status === 'ACTIVE') return res.json(view(row)); // reload of the return page
    if (row.status !== 'PENDING_APPROVAL' || !row.setup_token_id) {
      throw new HttpError(409, 'MANDATE_NOT_PENDING', `Mandate is ${row.status}; call POST /mandates/${row.id}/approve first.`);
    }
    const returned = typeof req.query.approval_token_id === 'string' ? req.query.approval_token_id : undefined;
    if (returned && returned !== row.setup_token_id) {
      throw new HttpError(400, 'TOKEN_MISMATCH', 'approval_token_id does not match the setup token issued for this mandate.');
    }
    const signer = loadSigner();
    const token = expectOk('create payment token', await createPaymentToken(row.setup_token_id));

    const signedAt = new Date();
    const signed: Row = {
      ...row,
      vault_id: token.body.id,
      signed_at: signedAt,
      signing_key_id: signer.keyId,
    };
    const { mandateHash, signature } = signMandate(signed);
    await db().query(
      `UPDATE mandates SET status = 'ACTIVE', vault_id = $2, paypal_customer_id = COALESCE($3, paypal_customer_id),
         signed_at = $4, signing_key_id = $5, mandate_hash = $6, signature = $7, updated_at = now()
       WHERE id = $1`,
      [row.id, token.body.id, token.body.customer?.id ?? null, signedAt, signer.keyId, mandateHash, signature],
    );
    await db().query(
      `UPDATE buyers SET paypal_customer_id = COALESCE(paypal_customer_id, $2), updated_at = now() WHERE id = $1`,
      [row.buyer_id, token.body.customer?.id ?? null],
    );
    res.json(view(await load(row.id)));
  }),
);

mandates.get(
  '/:id/vault-cancel',
  route(async (req, res) => {
    const row = await load(uuidParam(req.params.id, 'Mandate'));
    if (row.status === 'PENDING_APPROVAL') {
      await db().query(`UPDATE mandates SET status = 'DRAFT', updated_at = now() WHERE id = $1`, [row.id]);
    }
    res.json({ mandate_id: row.id, status: row.status === 'PENDING_APPROVAL' ? 'DRAFT' : row.status, message: 'Approval was cancelled at PayPal.' });
  }),
);
