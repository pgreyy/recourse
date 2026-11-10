import type pg from 'pg';
import { db } from '../shared/db/pool';
import { approveLink, createPaymentToken, createPaypalSetupToken } from '../paypal/vault';
import { expectOk } from '../paypal/types';

export type PaymentTokenRow = {
  id: string;
  owner_type: 'BUYER' | 'OPERATOR';
  buyer_id: string | null;
  operator_id: string | null;
  liability_agreement_id: string | null;
  status: 'PENDING' | 'ACTIVE' | 'REVOKED' | 'FAILED';
  setup_token_id: string | null;
  vault_id: string | null;
  paypal_customer_id: string | null;
  created_at: Date;
  activated_at: Date | null;
};

type Owner = { owner_type: 'BUYER'; buyer_id: string } | { owner_type: 'OPERATOR'; operator_id: string; liability_agreement_id: string };

/** Create a PayPal vault setup token and a PENDING payment_tokens row for it. */
export async function startVaulting(
  owner: Owner,
  opts: { description: string; returnUrl: string; cancelUrl: string },
): Promise<{ token: PaymentTokenRow; approveUrl: string | undefined; debugId?: string }> {
  const setup = expectOk('create setup token', await createPaypalSetupToken(opts));
  const { rows } = await db().query<PaymentTokenRow>(
    `INSERT INTO payment_tokens (owner_type, buyer_id, operator_id, liability_agreement_id, setup_token_id, paypal_customer_id)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [
      owner.owner_type,
      owner.owner_type === 'BUYER' ? owner.buyer_id : null,
      owner.owner_type === 'OPERATOR' ? owner.operator_id : null,
      owner.owner_type === 'OPERATOR' ? owner.liability_agreement_id : null,
      setup.body.id,
      setup.body.customer?.id ?? null,
    ],
  );
  return { token: rows[0], approveUrl: approveLink(setup.body), debugId: setup.debugId };
}

/** Exchange an approved setup token for a vault_id and mark the row ACTIVE (inside the caller's transaction). */
export async function finishVaulting(c: pg.PoolClient, tokenId: string): Promise<PaymentTokenRow> {
  const { rows } = await c.query<PaymentTokenRow>('SELECT * FROM payment_tokens WHERE id = $1 FOR UPDATE', [tokenId]);
  const row = rows[0];
  if (row.status === 'ACTIVE') return row;
  const res = expectOk('create payment token', await createPaymentToken(row.setup_token_id!));
  const updated = await c.query<PaymentTokenRow>(
    `UPDATE payment_tokens SET status = 'ACTIVE', vault_id = $2, paypal_customer_id = COALESCE($3, paypal_customer_id), activated_at = now()
     WHERE id = $1 RETURNING *`,
    [tokenId, res.body.id, res.body.customer?.id ?? null],
  );
  return updated.rows[0];
}

export async function getToken(id: string | null): Promise<PaymentTokenRow | undefined> {
  if (!id) return undefined;
  const { rows } = await db().query<PaymentTokenRow>('SELECT * FROM payment_tokens WHERE id = $1', [id]);
  return rows[0];
}

/** Public view: never more than PayPal ids and status. */
export function tokenView(t: PaymentTokenRow | undefined) {
  if (!t) return null;
  return {
    id: t.id,
    status: t.status,
    setup_token_id: t.setup_token_id,
    vault_id: t.vault_id,
    paypal_customer_id: t.paypal_customer_id,
    liability_agreement_id: t.liability_agreement_id,
    activated_at: t.activated_at,
  };
}
