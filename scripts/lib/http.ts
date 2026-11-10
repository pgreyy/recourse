import { randomUUID } from 'node:crypto';
import { API_BASE, need } from './env';
import { parseBody, type PPResponse } from './print';

/** Raw REST calls for the APIs the server SDK does not cover (Disputes, Invoicing, Webhooks). */

function headersToObject(h: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  h.forEach((v, k) => (out[k] = v));
  return out;
}

/** DNS and connection errors seen in WSL; safe to retry because every create call sends a PayPal-Request-Id. */
export const RETRYABLE = new Set(['ENOTFOUND', 'EAI_AGAIN', 'ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'UND_ERR_CONNECT_TIMEOUT']);

/** fetch with retries on network errors. Prints only the error code, never the request (it holds credentials). */
async function safeFetch(url: string | URL, init: RequestInit, label: string): Promise<Response> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fetch(url, init);
    } catch (e) {
      const err = e as { cause?: { code?: string }; code?: string };
      const code = err.cause?.code ?? err.code ?? 'UNKNOWN';
      if (RETRYABLE.has(code) && attempt < 8) {
        console.error(`${label}: network error ${code}, retrying (${attempt}/8)`);
        await new Promise((ok) => setTimeout(ok, 2000 * attempt));
        continue;
      }
      console.error(`${label}: network error ${code}`);
      process.exit(1);
    }
  }
}

async function toResponse(res: Response): Promise<PPResponse> {
  const headers = headersToObject(res.headers);
  return { status: res.status, debugId: headers['paypal-debug-id'], headers, body: parseBody(await res.text()) };
}

/** POST /v1/oauth2/token with client credentials. */
export async function requestToken(): Promise<PPResponse> {
  const basic = Buffer.from(`${need('PAYPAL_CLIENT_ID')}:${need('PAYPAL_CLIENT_SECRET')}`).toString('base64');
  const res = await safeFetch(
    `${API_BASE}/v1/oauth2/token`,
    {
      method: 'POST',
      headers: {
        Authorization: `Basic ${basic}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: 'grant_type=client_credentials',
    },
    'POST /v1/oauth2/token',
  );
  return toResponse(res);
}

let cached: { token: string; expiresAt: number } | undefined;

export async function accessToken(): Promise<string> {
  if (cached && Date.now() < cached.expiresAt) return cached.token;
  const res = await requestToken();
  if (res.status !== 200) {
    console.error('OAuth token request failed:', res.status, JSON.stringify(res.body));
    process.exit(1);
  }
  cached = { token: res.body.access_token, expiresAt: Date.now() + (res.body.expires_in - 60) * 1000 };
  return cached.token;
}

export type Part = { name: string; contentType: string; data: string | Buffer; filename?: string };

/** multipart/form-data with an explicit Content-Type per part (PayPal wants the "input" part as application/json). */
export function multipart(parts: Part[]): { body: Buffer; contentType: string } {
  const boundary = `----recourse${randomUUID().replace(/-/g, '')}`;
  const chunks: Buffer[] = [];
  for (const p of parts) {
    const disposition = `form-data; name="${p.name}"${p.filename ? `; filename="${p.filename}"` : ''}`;
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: ${disposition}\r\nContent-Type: ${p.contentType}\r\n\r\n`));
    chunks.push(typeof p.data === 'string' ? Buffer.from(p.data) : p.data);
    chunks.push(Buffer.from('\r\n'));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return { body: Buffer.concat(chunks), contentType: `multipart/form-data; boundary=${boundary}` };
}

export type CallOptions = {
  json?: unknown;
  parts?: Part[];
  headers?: Record<string, string>;
  query?: Record<string, string | undefined>;
};

/** Authenticated call to the sandbox. `path` may be a full href taken from a HATEOAS link. */
export async function pp(method: string, path: string, opts: CallOptions = {}): Promise<PPResponse> {
  const url = new URL(path.startsWith('http') ? path : `${API_BASE}${path}`);
  // HATEOAS links come back on api.sandbox.paypal.com; both hosts are sandbox. Anything else is refused.
  if (!['api-m.sandbox.paypal.com', 'api.sandbox.paypal.com'].includes(url.hostname) || url.protocol !== 'https:') {
    throw new Error(`Refusing non-sandbox URL: ${url.href}`);
  }
  for (const [k, v] of Object.entries(opts.query ?? {})) if (v !== undefined) url.searchParams.set(k, v);

  const headers: Record<string, string> = {
    Authorization: `Bearer ${await accessToken()}`,
    Accept: 'application/json',
    ...opts.headers,
  };
  let body: RequestInit["body"];
  if (opts.parts) {
    const mp = multipart(opts.parts);
    body = mp.body as unknown as RequestInit["body"]; // Node fetch accepts a Buffer at runtime
    headers['Content-Type'] = mp.contentType;
  } else if (opts.json !== undefined) {
    body = JSON.stringify(opts.json);
    headers['Content-Type'] = 'application/json';
  }
  const res = await safeFetch(url, { method, headers, body }, `${method} ${url.pathname}`);
  return toResponse(res);
}

export function requestId(): string {
  return randomUUID();
}

/**
 * Unsigned PayPal-Auth-Assertion JWT ({"alg":"none"}) acting as a sandbox account.
 * Format from PayPal's dispute sandbox guide: base64url(header).base64url({iss: client_id, email}).
 */
export function authAssertion(email: string): string {
  const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b64({ alg: 'none', typ: 'JWT' })}.${b64({ iss: need('PAYPAL_CLIENT_ID'), email })}.`;
}
