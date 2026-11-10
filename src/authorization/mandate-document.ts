import { checkDocument, signDocument, type DocumentCheck } from '../shared/crypto/signing';

export const BUDGET_RULE =
  'max_total is the most that may be spent under this mandate across all of its orders together, including tax and shipping.';

/** The mandate columns that go into the signed document. */
export type MandateRow = {
  id: string;
  lineage_id: string;
  version: number;
  buyer_email: string;
  source_text: string;
  spec: unknown;
  vault_id: string | null;
  signed_at: Date | null;
  signing_key_id: string | null;
  previous_mandate_hash: string | null;
  mandate_hash: string | null;
  signature: string | null;
};

/**
 * The document Recourse signs, rebuilt from the live columns every time it is checked. Editing any
 * of these columns in the database (spec, buyer, vault_id, version, ...) makes signature_valid false.
 * previous_mandate_hash links each version to the one it replaced.
 */
export function mandateDocument(row: MandateRow) {
  if (!row.vault_id || !row.signed_at || !row.signing_key_id) throw new Error('mandate is not signed yet');
  return {
    type: 'recourse.mandate',
    format: 1,
    mandate_id: row.id,
    lineage_id: row.lineage_id,
    mandate_version: row.version,
    previous_mandate_hash: row.previous_mandate_hash?.trim() ?? null,
    buyer: { email: row.buyer_email },
    source_text: row.source_text,
    spec: row.spec,
    budget_rule: BUDGET_RULE,
    payment_method: { provider: 'paypal', vault_id: row.vault_id },
    issued_at: row.signed_at.toISOString(),
    signing_key_id: row.signing_key_id,
  };
}

/** Sign a row that already has vault_id, signed_at and signing_key_id set. */
export function signMandate(row: MandateRow): { mandateHash: string; signature: string } {
  const s = signDocument(mandateDocument(row));
  if (s.keyId !== row.signing_key_id) throw new Error('signing key id mismatch');
  return { mandateHash: s.hash, signature: s.signature };
}

export function checkMandateSignature(row: MandateRow): { signature_valid: boolean; signature_check: DocumentCheck } {
  if (!row.signature || !row.vault_id || !row.signed_at || !row.signing_key_id) {
    return { signature_valid: false, signature_check: { valid: false, reason: 'NOT_SIGNED', computed_hash: null } };
  }
  const check = checkDocument(mandateDocument(row), { hash: row.mandate_hash, signature: row.signature, keyId: row.signing_key_id });
  return { signature_valid: check.valid, signature_check: check };
}
