import { ApiError, Client, Environment, OrdersController, PaymentsController, VaultController } from '@paypal/paypal-server-sdk';
import { need } from './env';
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

type SdkResponse = { statusCode: number; headers: Record<string, string>; body: unknown };

/**
 * Run an SDK call and print PayPal's raw JSON (snake_case, exactly as sent),
 * not the SDK's camelCase model. API errors are printed the same way instead of thrown.
 */
export async function sdkCall(label: string, call: () => Promise<SdkResponse>): Promise<PPResponse> {
  let r: SdkResponse;
  try {
    r = await call();
  } catch (e) {
    if (!(e instanceof ApiError)) throw e;
    r = e;
  }
  const body = typeof r.body === 'string' ? parseBody(r.body) : r.body;
  return show(label, { status: r.statusCode, headers: r.headers, debugId: r.headers?.['paypal-debug-id'], body });
}
