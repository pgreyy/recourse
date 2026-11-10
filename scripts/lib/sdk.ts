import { ApiError, Client, Environment, OrdersController, PaymentsController, VaultController } from '@paypal/paypal-server-sdk';
import { need } from './env';
import { RETRYABLE } from './http';
import { parseBody, show, type PPResponse } from './print';

/** PayPal Server SDK client, sandbox only. */
export const client = new Client({
  clientCredentialsAuthCredentials: {
    oAuthClientId: need('PAYPAL_CLIENT_ID'),
    oAuthClientSecret: need('PAYPAL_CLIENT_SECRET'),
  },
  environment: Environment.Sandbox,
  timeout: 30_000,
});

export const vault = new VaultController(client);
export const orders = new OrdersController(client);
export const payments = new PaymentsController(client);

type SdkResponse ={ statusCode: number; headers: Record<string, string>; body: unknown };

/**
 * Run an SDK call and print PayPal's raw JSON (snake_case, exactly as sent),
 * not the SDK's camelCase model. API errors are printed the same way instead of thrown.
 */
export async function sdkCall(label: string, call: () => Promise<SdkResponse>): Promise<PPResponse> {
  let r: SdkResponse | undefined;
  for (let attempt = 1; !r; attempt++) {
    try {
      r = await call();
    } catch (e) {
      if (e instanceof ApiError) {
        r = e;
        break;
      }
      // Never rethrow or print the raw error: SDK/axios errors carry the request headers,
      // including the Basic auth header with the client secret.
      const err = e as { code?: string; message?: string; cause?: { code?: string } };
      const code = err.code ?? err.cause?.code ?? 'UNKNOWN';
      if (RETRYABLE.has(code) && attempt < 8) {
        console.error(`${label}: network error ${code}, retrying (${attempt}/8)`);
        await new Promise((ok) => setTimeout(ok, 2000 * attempt));
        continue;
      }
      console.error(`${label}: network error ${code}: ${String(err.message ?? '').slice(0, 200)}`);
      process.exit(1);
    }
  }
  const body = typeof r.body === 'string' ? parseBody(r.body) : r.body;
  return show(label, { status: r.statusCode, headers: r.headers, debugId: r.headers?.['paypal-debug-id'], body });
}
