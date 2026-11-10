import { createHash } from 'node:crypto';

/**
 * Canonical JSON in the style of RFC 8785 (JCS): object keys sorted by UTF-16 code units,
 * no whitespace, strings and numbers serialized exactly as JSON.stringify does (which is what
 * JCS specifies for ES engines). Undefined object members are dropped, as JSON.stringify does,
 * so a value hashes the same before and after a round trip through Postgres jsonb.
 * Non-finite numbers and bigints are rejected.
 */
export function canonicalize(value: unknown): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      if (!Number.isFinite(value)) throw new TypeError('canonicalize: non-finite number');
      return JSON.stringify(value);
    case 'string':
      return JSON.stringify(value);
    case 'bigint':
      throw new TypeError('canonicalize: bigint is not JSON');
    case 'object': {
      const withJson = value as { toJSON?: () => unknown };
      if (typeof withJson.toJSON === 'function') return canonicalize(withJson.toJSON());
      if (Array.isArray(value)) {
        return `[${value.map((v) => (v === undefined || typeof v === 'function' ? 'null' : canonicalize(v))).join(',')}]`;
      }
      const obj = value as Record<string, unknown>;
      const keys = Object.keys(obj)
        .filter((k) => obj[k] !== undefined && typeof obj[k] !== 'function')
        .sort(); // default sort compares UTF-16 code units, as JCS requires
      return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize(obj[k])}`).join(',')}}`;
    }
    default:
      throw new TypeError(`canonicalize: unsupported type ${typeof value}`);
  }
}

export function sha256Hex(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

/** sha256 hex of the canonical JSON of `value`. */
export function canonicalHash(value: unknown): string {
  return sha256Hex(canonicalize(value));
}
