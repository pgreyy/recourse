import { createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify, type KeyObject } from 'node:crypto';
import { config, ConfigError } from '../../config';
import { canonicalize, sha256Hex } from './canonical';

/**
 * Recourse's Ed25519 signing key. RECOURSE_SIGNING_KEY holds the private key as base64 of its
 * PKCS#8 DER encoding (scripts/gen-signing-key.ts makes one). The key id is derived from the
 * public key, so a signature records which key made it.
 */
type Signer = { privateKey: KeyObject; publicKey: KeyObject; keyId: string; publicJwk: Record<string, unknown> };
let signer: Signer | undefined;

export function keyIdFor(publicKey: KeyObject): string {
  const raw = Buffer.from(publicKey.export({ format: 'jwk' }).x as string, 'base64url');
  return `ed25519:${sha256Hex(raw).slice(0, 16)}`;
}

export function loadSigner(): Signer {
  if (signer) return signer;
  let privateKey: KeyObject;
  try {
    privateKey = createPrivateKey({ key: Buffer.from(config.signingKey(), 'base64'), format: 'der', type: 'pkcs8' });
  } catch (e) {
    if (e instanceof ConfigError) throw e;
    throw new ConfigError('RECOURSE_SIGNING_KEY is not a valid base64 PKCS#8 Ed25519 key (run npm run keygen)');
  }
  if (privateKey.asymmetricKeyType !== 'ed25519') throw new ConfigError('RECOURSE_SIGNING_KEY must be an Ed25519 key');
  const publicKey = createPublicKey(privateKey);
  signer = { privateKey, publicKey, keyId: keyIdFor(publicKey), publicJwk: publicKey.export({ format: 'jwk' }) };
  return signer;
}

/** Ed25519 signature over the given bytes, base64url. */
export function signBytes(data: string | Buffer): { signature: string; keyId: string } {
  const s = loadSigner();
  return { signature: sign(null, Buffer.from(data), s.privateKey).toString('base64url'), keyId: s.keyId };
}

export function verifyBytes(data: string | Buffer, signature: string): boolean {
  try {
    return verify(null, Buffer.from(data), loadSigner().publicKey, Buffer.from(signature, 'base64url'));
  } catch (e) {
    if (e instanceof ConfigError) throw e;
    return false;
  }
}

/** New key pair: base64 PKCS#8 private key for .env, plus the public JWK and key id. */
export function generateSigningKey(): { privateKeyB64: string; keyId: string; publicJwk: Record<string, unknown> } {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return {
    privateKeyB64: privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64'),
    keyId: keyIdFor(publicKey),
    publicJwk: publicKey.export({ format: 'jwk' }),
  };
}

/**
 * Sign a JSON document: canonical JSON -> sha256 hex + Ed25519 signature (base64url) with the
 * current key. Signed instructions, liability-agreement acceptances and recorder checkpoints all use this.
 */
export function signDocument(doc: unknown): { canonical: string; hash: string; signature: string; keyId: string } {
  const canonical = canonicalize(doc);
  const { signature, keyId } = signBytes(canonical);
  return { canonical, hash: sha256Hex(canonical), signature, keyId };
}

export type DocumentCheck = {
  valid: boolean;
  reason: 'OK' | 'NOT_SIGNED' | 'HASH_MISMATCH' | 'BAD_SIGNATURE' | 'UNKNOWN_KEY';
  computed_hash: string | null;
};

/** Recompute the hash of `doc`, compare with the stored hash, and verify the stored signature. */
export function checkDocument(doc: unknown, stored: { hash?: string | null; signature?: string | null; keyId?: string | null }): DocumentCheck {
  if (!stored.signature || !stored.keyId) return { valid: false, reason: 'NOT_SIGNED', computed_hash: null };
  const canonical = canonicalize(doc);
  const computed = sha256Hex(canonical);
  if (loadSigner().keyId !== stored.keyId) return { valid: false, reason: 'UNKNOWN_KEY', computed_hash: computed };
  if (stored.hash !== undefined && stored.hash !== null && stored.hash.trim() !== computed) {
    return { valid: false, reason: 'HASH_MISMATCH', computed_hash: computed };
  }
  if (!verifyBytes(canonical, stored.signature)) return { valid: false, reason: 'BAD_SIGNATURE', computed_hash: computed };
  return { valid: true, reason: 'OK', computed_hash: computed };
}
