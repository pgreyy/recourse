import { randomUUID } from 'node:crypto';
import { parseBody, PayPalApiError, PayPalNetworkError, type PPResponse } from './types';

/** Recourse talks to the PayPal sandbox only. There is deliberately no switch to live. */
export const API_BASE = 'https://api-m.sandbox.paypal.com';
const SANDBOX_HOSTS = ['api-m.sandbox.paypal.com', 'api.sandbox.paypal.com'];

/** DNS and connection errors seen in WSL; safe to retry because every create call sends a PayPal-Request-Id. */
export const RETRYABLE = new Set(['ENOTFOUND', 'EAI_AGAIN', 'ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'UND_ERR_CONNECT_TIMEOUT']);
const MAX_ATTEMPTS = 8;

export function credentials(): { clientId: string; clientSecret: string } {
  const clientId = process.env.PAYPAL_CLIENT_ID?.trim();
  const clientSecret = process.env.PAYPAL_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) throw new Error('PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET must be set in .env');
  return { clientId, clientSecret };
}

/** Network error code from a fetch, axios or SDK error, without touching anything else on it. */
export function networkErrorCode(e: unknown): string {
  const err = e as { code?: string; cause?: { code?: string } };
  return err?.cause?.code ?? err?.code ?? 'UNKNOWN';
}

/**
 * Run `attempt` with retries on network errors. Logs only the label and the error code.
 * Throws PayPalNetworkError once retries are used up or the error is not retryable.
 */
export async function withRetry<T>(label: string, attempt: () => Promise<T>): Promise<T> {
  for (let n = 1; ; n++) {
    try {
      return await attempt();
    } catch (e) {
      if (e instanceof PayPalApiError) throw e;
      const code = networkErrorCode(e);
      if (RETRYABLE.has(code) && n < MAX_ATTEMPTS) {
        console.error(`${label}: network error ${code}, retrying (${n}/${MAX_ATTEMPTS})`);
        await new Promise((ok) => setTimeout(ok, 2000 * n));
        continue;
      }
      throw new PayPalNetworkError(label, code);
    }
  }
}

function headersToObject(h: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  h.forEach((v, k) => (out[k] = v));
  return out;
}

async function toResponse(res: Response): Promise<PPResponse> {
  const headers = headersToObject(res.headers);
  return { status: res.status, debugId: headers['paypal-debug-id'], headers, body: parseBody(await res.text()) };
}

/** POST /v1/oauth2/token with client credentials. Returns the raw response (probe 1 prints it). */
export async function requestToken(): Promise<PPResponse> {
  const { clientId, clientSecret } = credentials();
  const basic = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
  return withRetry('POST /v1/oauth2/token', async () =>
    toResponse(
      await fetch(`${API_BASE}/v1/oauth2/token`, {
        method: 'POST',
        headers: {
          Authorization: `Basic ${basic}`,
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json',
        },
        body: 'grant_type=client_credentials',
      }),
    ),
  );
}

let cached: { token: string; expiresAt: number } | undefined;

/** Cached bearer token; refreshed a minute before it expires. */
export async function accessToken(): Promise<string> {
  if (cached && Date.now() < cached.expiresAt) return cached.token;
  const res = await requestToken();
  if (res.status !== 200) throw new PayPalApiError('POST /v1/oauth2/token', res);
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

/**
 * Authenticated REST call to the sandbox, for APIs the server SDK does not cover
 * (Disputes, Invoicing, Webhooks). `path` may be a full href from a HATEOAS link.
 */
export async function pp(method: string, path: string, opts: CallOptions = {}): Promise<PPResponse> {
  const url = new URL(path.startsWith('http') ? path : `${API_BASE}${path}`);
  if (!SANDBOX_HOSTS.includes(url.hostname) || url.protocol !== 'https:') {
    throw new Error(`Refusing non-sandbox URL: ${url.href}`);
  }
  for (const [k, v] of Object.entries(opts.query ?? {})) if (v !== undefined) url.searchParams.set(k, v);

  const headers: Record<string, string> = {
    Authorization: `Bearer ${await accessToken()}`,
    Accept: 'application/json',
    ...opts.headers,
  };
  let body: RequestInit['body'];
  if (opts.parts) {
    const mp = multipart(opts.parts);
    body = mp.body as unknown as RequestInit['body']; // Node fetch accepts a Buffer at runtime
    headers['Content-Type'] = mp.contentType;
  } else if (opts.json !== undefined) {
    body = JSON.stringify(opts.json);
    headers['Content-Type'] = 'application/json';
  }
  return withRetry(`${method} ${url.pathname}`, async () => toResponse(await fetch(url, { method, headers, body })));
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
  return `${b64({ alg: 'none', typ: 'JWT' })}.${b64({ iss: credentials().clientId, email })}.`;
}
