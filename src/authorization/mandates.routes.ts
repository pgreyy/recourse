import { Router } from 'express';
import type pg from 'pg';
import { z } from 'zod';
import { config } from '../config';
import { loadSigner } from '../shared/crypto/signing';
import { db, tx } from '../shared/db/pool';
import { HttpError, notFound, route, zodDetails } from '../shared/http/errors';
import { uuidParam } from '../shared/http/ids';
import { wantsPage } from '../shared/http/page';
import { compileMandate } from './mandate-compiler';
import { checkMandateSignature, signMandate, type MandateRow } from './mandate-document';
import { MandateSpec } from './mandate-spec';
import { mandateUsage } from './mandate-usage';
import { finishVaulting, getToken, startVaulting, tokenView } from './payment-tokens';

export const mandates = Router();

export type Row = MandateRow & {
  buyer_id: string;
  supersedes_id: string | null;
  status: 'DRAFT' | 'ACTIVE' | 'CONSUMED' | 'EXPIRED' | 'REVOKED' | 'SUPERSEDED';
  expires_at: Date;
  llm_provider: string | null;
  llm_model: string | null;
  payment_token_id: string | null;
  revoked_at: Date | null;
  created_at: Date;
  updated_at: Date;
};

const SELECT = `SELECT m.*, b.email AS buyer_email, pt.vault_id
                FROM mandates m JOIN buyers b ON b.id = m.buyer_id
                LEFT JOIN payment_tokens pt ON pt.id = m.payment_token_id`;

/** Load one version; ACTIVE instructions past expires_at becomes EXPIRED on read. */
export async function loadMandate(id: string, c: pg.Pool | pg.PoolClient = db()): Promise<Row> {
  return load(id, c);
}

async function load(id: string, c: pg.Pool | pg.PoolClient = db()): Promise<Row> {
  const { rows } = await c.query<Row>(`${SELECT} WHERE m.id = $1`, [id]);
  const row = rows[0];
  if (!row) throw notFound('Mandate', id);
  if (row.status === 'ACTIVE' && row.expires_at.getTime() <= Date.now()) {
    await c.query(`UPDATE mandates SET status = 'EXPIRED', updated_at = now() WHERE id = $1 AND status = 'ACTIVE'`, [id]);
    row.status = 'EXPIRED';
  }
  return row;
}

/** Remaining budget across the whole lineage (all versions, all captured orders), per the aggregate rule. */
async function budget(row: Row) {
  const spec = row.spec as MandateSpec;
  const used = await mandateUsage(row.lineage_id);
  const maxCents = Math.round(Number(spec.max_total.value) * 100);
  return {
    rule: 'aggregate across all orders under these instructions, tax and shipping included',
    max_total: spec.max_total,
    spent: { value: (used.spent_cents / 100).toFixed(2), currency: spec.max_total.currency },
    remaining: { value: (Math.max(0, maxCents - used.spent_cents) / 100).toFixed(2), currency: spec.max_total.currency },
    orders_placed: used.orders_placed,
    max_orders: spec.max_orders,
    orders_remaining: Math.max(0, spec.max_orders - used.orders_placed),
    units_bought: used.units_bought,
  };
}

async function view(row: Row) {
  const base = config.publicBaseUrl();
  const versions = await db().query(
    'SELECT id, version, status, mandate_hash, created_at FROM mandates WHERE lineage_id = $1 ORDER BY version',
    [row.lineage_id],
  );
  const links = [{ rel: 'self', method: 'GET', href: `${base}/mandates/${row.id}` }];
  if (row.status === 'DRAFT') links.push({ rel: 'approve', method: 'POST', href: `${base}/mandates/${row.id}/approve` });
  if (row.status === 'DRAFT' || row.status === 'ACTIVE') {
    links.push({ rel: 'edit', method: 'PUT', href: `${base}/mandates/${row.id}` });
    links.push({ rel: 'revoke', method: 'POST', href: `${base}/mandates/${row.id}/revoke` });
  }
  return {
    id: row.id,
    lineage_id: row.lineage_id,
    version: row.version,
    status: row.status,
    is_current: row.status !== 'SUPERSEDED',
    buyer_email: row.buyer_email,
    source_text: row.source_text,
    spec: row.spec,
    remaining_budget: await budget(row),
    expires_at: row.expires_at,
    payment_method: tokenView(await getToken(row.payment_token_id)),
    llm: { provider: row.llm_provider, model: row.llm_model },
    signed_at: row.signed_at,
    signing_key_id: row.signing_key_id,
    previous_mandate_hash: row.previous_mandate_hash?.trim() ?? null,
    mandate_hash: row.mandate_hash?.trim() ?? null,
    signature: row.signature,
    ...checkMandateSignature(row),
    versions: versions.rows.map((v) => ({ ...v, mandate_hash: v.mandate_hash?.trim() ?? null })),
    created_at: row.created_at,
    updated_at: row.updated_at,
    links,
  };
}

/** Compile text with the LLM and validate; a draft that fails the schema is rejected with 422. */
async function compileStrict(text: string) {
  const { draft, provider, modelId } = await compileMandate(text);
  return { spec: validate(draft, draft), provider, modelId };
}

function validate(input: unknown, shownDraft: unknown): MandateSpec {
  const r = MandateSpec.safeParse(input);
  if (!r.success) {
    throw new HttpError(422, 'MANDATE_REJECTED', 'The instructions do not pass the schema. Nothing was saved.', {
      issues: zodDetails(r.error),
      draft: shownDraft,
    });
  }
  return r.data;
}

const CreateMandate = z.object({
  buyer_email: z.string().trim().toLowerCase().email(),
  text: z.string().trim().min(3).max(2000),
});

/** POST /mandates { buyer_email, text } -> DRAFT, version 1 */
mandates.post(
  '/',
  route(async (req, res) => {
    const body = CreateMandate.parse(req.body);
    const { spec, provider, modelId } = await compileStrict(body.text);
    const id = await tx(async (c) => {
      const buyer = await c.query<{ id: string }>(
        `INSERT INTO buyers (email) VALUES ($1) ON CONFLICT (email) DO UPDATE SET updated_at = now() RETURNING id`,
        [body.buyer_email],
      );
      const { rows } = await c.query<{ id: string }>(
        `INSERT INTO mandates (lineage_id, version, buyer_id, source_text, spec, expires_at, llm_provider, llm_model)
         VALUES (gen_random_uuid(), 1, $1, $2, $3, $4, $5, $6) RETURNING id`,
        [buyer.rows[0].id, body.text, JSON.stringify(spec), spec.expires_at, provider, modelId],
      );
      return rows[0].id;
    });
    res.status(201).json(await view(await load(id)));
  }),
);

mandates.get(
  '/:id',
  route(async (req, res) => {
    res.json(await view(await load(uuidParam(req.params.id, 'Mandate'))));
  }),
);

/** POST /mandates/:id/approve: buyer saves PayPal for these instructions; returns the approve link. */
mandates.post(
  '/:id/approve',
  route(async (req, res) => {
    const row = await load(uuidParam(req.params.id, 'Mandate'));
    if (row.status !== 'DRAFT') throw new HttpError(409, 'MANDATE_NOT_DRAFT', `Mandate version ${row.version} is ${row.status}; only a DRAFT can be approved.`);
    loadSigner(); // fail before PayPal if the signing key is missing
    const spec = row.spec as MandateSpec;
    const base = config.publicBaseUrl();
    const started = await startVaulting(
      { owner_type: 'BUYER', buyer_id: row.buyer_id },
      {
        description: `Recourse instructions: ${spec.category}, up to ${spec.max_total.value} ${spec.max_total.currency} in total`.slice(0, 127),
        returnUrl: `${base}/mandates/${row.id}/vault-return`,
        cancelUrl: `${base}/mandates/${row.id}/vault-cancel`,
      },
    );
    await tx(async (c) => {
      if (row.payment_token_id) {
        await c.query(`UPDATE payment_tokens SET status = 'FAILED' WHERE id = $1 AND status = 'PENDING'`, [row.payment_token_id]);
      }
      await c.query('UPDATE mandates SET payment_token_id = $2, updated_at = now() WHERE id = $1', [row.id, started.token.id]);
    });
    res.json({
      mandate_id: row.id,
      status: row.status,
      setup_token_id: started.token.setup_token_id,
      approve_url: started.approveUrl,
      paypal_debug_id: started.debugId,
      next: 'Open approve_url as the buyer sandbox account. PayPal then redirects to vault-return, which signs the instructions and sets ACTIVE.',
    });
  }),
);

/** PayPal redirects here after approval: vault_id stored, instructions signed, ACTIVE. */
mandates.get(
  '/:id/vault-return',
  route(async (req, res) => {
    const id = uuidParam(req.params.id, 'Mandate');
    const row = await load(id);
    if (row.status === 'ACTIVE') return wantsPage(req) ? res.redirect(`/app/buyer?instructions=${row.id}&paypal=approved`) : res.json(await view(row)); // reload of the return page
    if (row.status !== 'DRAFT' || !row.payment_token_id) {
      throw new HttpError(409, 'MANDATE_NOT_PENDING', `Mandate is ${row.status}; call POST /mandates/${id}/approve first.`);
    }
    const token = await getToken(row.payment_token_id);
    const returned = typeof req.query.approval_token_id === 'string' ? req.query.approval_token_id : undefined;
    if (returned && returned !== token?.setup_token_id) {
      throw new HttpError(400, 'TOKEN_MISMATCH', 'approval_token_id does not match the setup token issued for these instructions.');
    }
    const signer = loadSigner();
    await tx(async (c) => {
      const active = await finishVaulting(c, row.payment_token_id!);
      const signedAt = new Date();
      const toSign: Row = { ...row, vault_id: active.vault_id, signed_at: signedAt, signing_key_id: signer.keyId };
      const { mandateHash, signature } = signMandate(toSign);
      await c.query(
        `UPDATE mandates SET status = 'ACTIVE', signed_at = $2, signing_key_id = $3, mandate_hash = $4, signature = $5, updated_at = now()
         WHERE id = $1`,
        [id, signedAt, signer.keyId, mandateHash, signature],
      );
      await c.query('UPDATE buyers SET paypal_customer_id = COALESCE(paypal_customer_id, $2), updated_at = now() WHERE id = $1', [
        row.buyer_id,
        active.paypal_customer_id,
      ]);
    });
    if (wantsPage(req)) return res.redirect(`/app/buyer?instructions=${id}&paypal=approved`);
    res.json(await view(await load(id)));
  }),
);

mandates.get(
  '/:id/vault-cancel',
  route(async (req, res) => {
    const row = await load(uuidParam(req.params.id, 'Mandate'));
    if (row.payment_token_id) {
      await db().query(`UPDATE payment_tokens SET status = 'FAILED' WHERE id = $1 AND status = 'PENDING'`, [row.payment_token_id]);
    }
    if (wantsPage(req)) return res.redirect(`/app/buyer?instructions=${row.id}&paypal=cancelled`);
    res.json({ mandate_id: row.id, status: row.status, message: 'Approval was cancelled at PayPal. Call approve again for a new link.' });
  }),
);

const EditMandate = z
  .object({
    text: z.string().trim().min(3).max(2000).optional(),
    changes: z.record(z.string(), z.unknown()).optional(),
  })
  .refine((b) => (b.text ? 1 : 0) + (b.changes ? 1 : 0) === 1, 'send either text (recompiled by the LLM) or changes (fields to replace), not both');

/**
 * PUT /mandates/:id { text } or { changes }: every edit creates a new version. For ACTIVE instructions, the
 * new version is signed at once (same saved PayPal, previous_mandate_hash links the versions);
 * a DRAFT's new version stays DRAFT. The old version becomes SUPERSEDED.
 */
mandates.put(
  '/:id',
  route(async (req, res) => {
    const row = await load(uuidParam(req.params.id, 'Mandate'));
    if (row.status !== 'DRAFT' && row.status !== 'ACTIVE') {
      throw new HttpError(409, 'MANDATE_NOT_EDITABLE', `Mandate version ${row.version} is ${row.status}; only the current DRAFT or ACTIVE version can be edited.`);
    }
    const body = EditMandate.parse(req.body);
    let spec: MandateSpec;
    let sourceText = row.source_text;
    let llm = { provider: row.llm_provider, modelId: row.llm_model };
    if (body.text) {
      const compiled = await compileStrict(body.text);
      spec = compiled.spec;
      sourceText = body.text;
      llm = { provider: compiled.provider, modelId: compiled.modelId };
    } else {
      const old = row.spec as MandateSpec;
      const merged: Record<string, unknown> = { ...old, ...body.changes };
      // expires_at that was only the default for the old deadline follows a new deadline.
      if ('deadline' in body.changes! && !('expires_at' in body.changes!) && old.expires_at === `${old.deadline}T23:59:59.000Z`) {
        delete merged.expires_at;
      }
      spec = validate(merged, merged);
    }
    const signer = row.status === 'ACTIVE' ? loadSigner() : undefined;

    const newId = await tx(async (c) => {
      // Lock the lineage, retire the current version, then insert the next one.
      await c.query('SELECT id FROM mandates WHERE lineage_id = $1 FOR UPDATE', [row.lineage_id]);
      const cur = await c.query<{ status: string }>('SELECT status FROM mandates WHERE id = $1', [row.id]);
      if (cur.rows[0].status !== row.status) throw new HttpError(409, 'MANDATE_CHANGED', 'Mandate changed while editing; reload and try again.');
      await c.query(`UPDATE mandates SET status = 'SUPERSEDED', updated_at = now() WHERE id = $1`, [row.id]);
      const inserted = await c.query<{ id: string }>(
        `INSERT INTO mandates (lineage_id, version, supersedes_id, buyer_id, status, source_text, spec, expires_at, llm_provider, llm_model, payment_token_id)
         VALUES ($1, $2, $3, $4, 'DRAFT', $5, $6, $7, $8, $9, $10) RETURNING id`,
        [row.lineage_id, row.version + 1, row.id, row.buyer_id, sourceText, JSON.stringify(spec), spec.expires_at, llm.provider, llm.modelId, row.payment_token_id],
      );
      const id = inserted.rows[0].id;
      if (signer) {
        const signedAt = new Date();
        const fresh = (await c.query<Row>(`${SELECT} WHERE m.id = $1`, [id])).rows[0];
        const toSign: Row = { ...fresh, signed_at: signedAt, signing_key_id: signer.keyId, previous_mandate_hash: row.mandate_hash };
        const { mandateHash, signature } = signMandate(toSign);
        await c.query(
          `UPDATE mandates SET status = 'ACTIVE', signed_at = $2, signing_key_id = $3, previous_mandate_hash = $4, mandate_hash = $5, signature = $6
           WHERE id = $1`,
          [id, signedAt, signer.keyId, row.mandate_hash, mandateHash, signature],
        );
      }
      return id;
    });
    res.status(201).json(await view(await load(newId)));
  }),
);

/** POST /mandates/:id/revoke: the buyer withdraws the instructions; its saved payment method stops being usable. */
mandates.post(
  '/:id/revoke',
  route(async (req, res) => {
    const row = await load(uuidParam(req.params.id, 'Mandate'));
    if (row.status !== 'DRAFT' && row.status !== 'ACTIVE') throw new HttpError(409, 'MANDATE_NOT_REVOCABLE', `Mandate is ${row.status}.`);
    await tx(async (c) => {
      await c.query(`UPDATE mandates SET status = 'REVOKED', revoked_at = now(), updated_at = now() WHERE id = $1`, [row.id]);
      if (row.payment_token_id) {
        await c.query(`UPDATE payment_tokens SET status = 'REVOKED', revoked_at = now() WHERE id = $1 AND status IN ('ACTIVE', 'PENDING')`, [row.payment_token_id]);
      }
    });
    res.json(await view(await load(row.id)));
  }),
);
