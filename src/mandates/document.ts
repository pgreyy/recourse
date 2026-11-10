import { canonicalize, sha256Hex } from '../crypto/canonical';
import { loadSigner, signBytes, verifyBytes } from '../crypto/signing';

/** The mandate columns that go into the signed document. */
export type MandateRow = {
  id: string;
  buyer_email: string;
  source_text: string;
  spec: unknown;
  vault_id: string | null;
  signed_at: Date | null;
  signing_key_id: string | null;
  mandate_hash: string | null;
  signature: string | null;
};

/**
 * The document Recourse signs, rebuilt from the live columns every time. Editing any of these
 * columns in the database (spec, buyer email, vault_id, ...) makes signature_valid false.
 */
export function mandateDocument(row: MandateRow) {
  if (!row.vault_id || !row.signed_at || !row.signing_key_id) throw new Error('mandate is not signed yet');
  return {
    type: 'recourse.mandate',
    version: 1,
    mandate_id: row.id,
    buyer: { email: row.buyer_email },
    source_text: row.source_text,
    spec: row.spec,
    payment_method: { provider: 'paypal', vault_id: row.vault_id },
    issued_at: row.signed_at.toISOString(),
    signing_key_id: row.signing_key_id,
  };
}

/** Canonical bytes, mandate_hash and Ed25519 signature for a row that has vault_id, signed_at and key id set. */
export function signMandate(row: MandateRow): { canonical: string; mandateHash: string; signature: string } {
  if (loadSigner().keyId !== row.signing_key_id) throw new Error('signing key id mismatch');
  const canonical = canonicalize(mandateDocument(row));
  return { canonical, mandateHash: sha256Hex(canonical), signature: signBytes(canonical).signature };
}

export type SignatureCheck = {
  signature_valid: boolean;
  signature_check: {
    reason: 'OK' | 'NOT_SIGNED' | 'HASH_MISMATCH' | 'BAD_SIGNATURE' | 'UNKNOWN_KEY';
    hash_matches: boolean | null;
    signature_verifies: boolean | null;
    key_id_matches: boolean | null;
    computed_hash: string | null;
  };
};

/** Recompute the hash from the live row and verify the stored signature with the current key. */
export function checkSignature(row: MandateRow): SignatureCheck {
  if (!row.signature || !row.mandate_hash || !row.signed_at || !row.vault_id || !row.signing_key_id) {
    return {
      signature_valid: false,
      signature_check: { reason: 'NOT_SIGNED', hash_matches: null, signature_verifies: null, key_id_matches: null, computed_hash: null },
    };
  }
  const canonical = canonicalize(mandateDocument(row));
  const computed = sha256Hex(canonical);
  const hashMatches = computed === row.mandate_hash.trim();
  const keyIdMatches = loadSigner().keyId === row.signing_key_id;
  const verifies = keyIdMatches && verifyBytes(canonical, row.signature);
  const reason = !keyIdMatches ? 'UNKNOWN_KEY' : !hashMatches ? 'HASH_MISMATCH' : !verifies ? 'BAD_SIGNATURE' : 'OK';
  return {
    signature_valid: reason === 'OK',
    signature_check: { reason, hash_matches: hashMatches, signature_verifies: verifies, key_id_matches: keyIdMatches, computed_hash: computed },
  };
}
