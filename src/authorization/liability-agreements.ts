import type pg from 'pg';
import { z } from 'zod';
import {
  AGENT_FAULT_DEFINITION,
  EVIDENCE_STANDARD,
  REVOCATION_TERMS,
  SANDBOX_DISCLOSURE,
} from '../accountability/definitions';
import { canonicalHash } from '../shared/crypto/canonical';
import { checkDocument, loadSigner, signDocument } from '../shared/crypto/signing';
import { HttpError } from '../shared/http/errors';
import { DEMO_MERCHANT, MERCHANT_NAMES } from '../transaction/catalog';

const Money = z.object({
  value: z
    .string()
    .regex(/^\d+(\.\d{1,2})?$/)
    .transform((v) => Number(v).toFixed(2))
    .refine((v) => Number(v) > 0, 'must be more than 0'),
  currency: z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/),
});

/** Body of POST /operators/:id/liability-agreement. Everything has the demo defaults. */
export const AgreementRequest = z
  .object({
    covered_agent_version_ids: z.array(z.string().uuid()).optional(),
    merchant_ids: z.array(z.string().trim().min(1)).min(1).default([DEMO_MERCHANT.id]),
    categories: z.array(z.string().trim().toLowerCase().min(1)).min(1).default(['running shoes']),
    per_incident_cap: Money.default({ value: '150.00', currency: 'USD' }),
    aggregate_cap: Money.default({ value: '500.00', currency: 'USD' }),
    appeal_window_hours: z.number().int().min(1).max(24 * 60).default(72),
  })
  .refine((b) => b.per_incident_cap.currency === b.aggregate_cap.currency, 'caps must use the same currency')
  .refine((b) => Number(b.per_incident_cap.value) <= Number(b.aggregate_cap.value), 'per_incident_cap cannot exceed aggregate_cap');
export type AgreementRequest = z.infer<typeof AgreementRequest>;

export type AgreementRow = {
  id: string;
  operator_id: string;
  version: number;
  status: 'DRAFT' | 'ACCEPTED' | 'SUPERSEDED' | 'REVOKED';
  terms: Record<string, any>;
  terms_hash: string;
  per_incident_cap: string;
  aggregate_cap: string;
  currency: string;
  appeal_window_hours: number;
  accepted_at: Date | null;
  accepted_by_name: string | null;
  accepted_by_email: string | null;
  acceptance_hash: string | null;
  acceptance_signature: string | null;
  signing_key_id: string | null;
  revoked_at: Date | null;
  created_at: Date;
};

type Operator = { id: string; name: string; email: string };

/** The full terms document. Its canonical sha256 is terms_hash; acceptance signs over that hash. */
export async function buildTerms(c: pg.PoolClient, op: Operator, version: number, req: AgreementRequest) {
  const versions = await c.query<{ agent_version_id: string; agent_id: string; agent_name: string; version: string }>(
    `SELECT v.id AS agent_version_id, a.id AS agent_id, a.name AS agent_name, v.version
     FROM agent_versions v JOIN agents a ON a.id = v.agent_id
     WHERE a.operator_id = $1 AND v.status = 'ACTIVE' AND a.status = 'ACTIVE'
       AND ($2::uuid[] IS NULL OR v.id = ANY($2::uuid[]))
     ORDER BY a.name, v.created_at`,
    [op.id, req.covered_agent_version_ids ?? null],
  );
  if (req.covered_agent_version_ids && versions.rows.length !== new Set(req.covered_agent_version_ids).size) {
    throw new HttpError(422, 'UNKNOWN_AGENT_VERSION', 'Every covered_agent_version_id must be an active version of this operator\'s agents.');
  }
  if (!versions.rows.length) {
    throw new HttpError(422, 'NO_AGENT_VERSIONS', 'Register at least one agent version (POST /agents, POST /agents/:id/versions) before creating the agreement.');
  }
  return {
    type: 'recourse.liability_agreement',
    format: 1,
    agreement_version: version,
    operator: { id: op.id, name: op.name, email: op.email },
    covered_agent_versions: versions.rows,
    covered_merchants: req.merchant_ids.map((id) => ({ id, name: MERCHANT_NAMES[id] ?? id })),
    categories: req.categories,
    per_incident_cap: req.per_incident_cap,
    aggregate_cap: req.aggregate_cap,
    agent_fault_definition: AGENT_FAULT_DEFINITION,
    evidence_standard: EVIDENCE_STANDARD,
    appeal_window_hours: req.appeal_window_hours,
    revocation_terms: REVOCATION_TERMS,
    payment_terms:
      'After accepting, the operator saves a PayPal payment method under this agreement. Recourse may charge it, payer not present, only to settle a final agent-fault decision (after the operator accepts it or the appeal window closes), up to the per-incident cap per incident and the total cap overall.',
    disclosure: SANDBOX_DISCLOSURE,
  };
}

export function termsHash(terms: unknown): string {
  return canonicalHash(terms);
}

/** The record Recourse signs when the operator accepts. */
export function acceptanceDocument(row: Pick<AgreementRow, 'id' | 'operator_id' | 'version' | 'terms_hash'>, by: { name: string; email: string }, at: Date, keyId: string) {
  return {
    type: 'recourse.liability_agreement_acceptance',
    format: 1,
    agreement_id: row.id,
    operator_id: row.operator_id,
    agreement_version: row.version,
    terms_hash: row.terms_hash.trim(),
    accepted_by: by,
    accepted_at: at.toISOString(),
    signing_key_id: keyId,
  };
}

export function signAcceptance(row: AgreementRow, by: { name: string; email: string }, at: Date) {
  const s = signDocument(acceptanceDocument(row, by, at, loadSigner().keyId));
  return { acceptanceHash: s.hash, signature: s.signature, keyId: s.keyId };
}

/** Agreement as returned by the API, with the terms hash and acceptance signature checked live. */
export function agreementView(row: AgreementRow) {
  const computedTermsHash = termsHash(row.terms);
  const termsOk = computedTermsHash === row.terms_hash.trim();
  let acceptance = null;
  if (row.accepted_at && row.accepted_by_name && row.accepted_by_email) {
    const doc = acceptanceDocument(row, { name: row.accepted_by_name, email: row.accepted_by_email }, row.accepted_at, row.signing_key_id ?? '');
    const check = checkDocument(doc, { hash: row.acceptance_hash, signature: row.acceptance_signature, keyId: row.signing_key_id });
    acceptance = {
      accepted_at: row.accepted_at,
      accepted_by: { name: row.accepted_by_name, email: row.accepted_by_email },
      acceptance_hash: row.acceptance_hash?.trim() ?? null,
      signature: row.acceptance_signature,
      signing_key_id: row.signing_key_id,
      signature_valid: check.valid && termsOk,
      signature_check: { ...check, terms_hash_matches: termsOk },
    };
  }
  return {
    id: row.id,
    version: row.version,
    status: row.status,
    terms: row.terms,
    terms_hash: row.terms_hash.trim(),
    terms_hash_valid: termsOk,
    acceptance,
    revoked_at: row.revoked_at,
    created_at: row.created_at,
  };
}
