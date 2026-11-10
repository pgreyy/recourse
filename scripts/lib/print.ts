import { appendFileSync, mkdirSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { parseBody as coreParseBody, type PPResponse } from '../../src/paypal/types';
import { LOCAL_DIR } from './env';

export type { PPResponse };

const SECRET_KEYS = new Set(['access_token', 'refresh_token', 'id_token', 'nonce']);

/** Copy of a value with token fields masked. Used for the log file and, unless SHOW_TOKEN=1, the console. */
export function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = SECRET_KEYS.has(k) && typeof v === 'string' ? mask(v) : redact(v);
    }
    return out;
  }
  return value;
}

function mask(v: string): string {
  return `${v.slice(0, 6)}...(${v.length} chars, masked)`;
}

export const parseBody = coreParseBody;

/** Print the full response and append it (token fields masked) to .local/logs/probes.jsonl. */
export function show(label: string, res: PPResponse): PPResponse {
  const showTokens = process.env.SHOW_TOKEN === '1';
  console.log(`\n=== ${label}`);
  console.log(`HTTP ${res.status}   paypal-debug-id: ${res.debugId ?? '-'}`);
  console.log(JSON.stringify(showTokens ? res.body : redact(res.body), null, 2));

  const dir = resolve(LOCAL_DIR, 'logs');
  mkdirSync(dir, { recursive: true });
  const line = {
    time: new Date().toISOString(),
    probe: basename(process.argv[1] ?? ''),
    label,
    status: res.status,
    debugId: res.debugId,
    body: redact(res.body),
  };
  appendFileSync(resolve(dir, 'probes.jsonl'), JSON.stringify(line) + '\n');
  return res;
}

/** Print every HATEOAS link as "rel  METHOD  href". */
export function showLinks(links: Array<{ rel: string; method?: string; href: string }> | undefined): void {
  if (!links?.length) {
    console.log('(no links)');
    return;
  }
  for (const l of links) console.log(`  ${l.rel.padEnd(28)} ${(l.method ?? 'GET').padEnd(6)} ${l.href}`);
}
