import { ApiError, Client, Environment, OrdersController, PaymentsController, VaultController } from '@paypal/paypal-server-sdk';
import { credentials, withRetry } from './http';
import { parseBody, type PPResponse } from './types';

type Controllers = { client: Client; vault: VaultController; orders: OrdersController; payments: PaymentsController };
let controllers: Controllers | undefined;

/** PayPal Server SDK controllers, sandbox only, created on first use. */
export function sdk(): Controllers {
  if (!controllers) {
    const { clientId, clientSecret } = credentials();
    const client = new Client({
      clientCredentialsAuthCredentials: { oAuthClientId: clientId, oAuthClientSecret: clientSecret },
      environment: Environment.Sandbox,
      timeout: 30_000,
    });
    controllers = {
      client,
      vault: new VaultController(client),
      orders: new OrdersController(client),
      payments: new PaymentsController(client),
    };
  }
  return controllers;
}

type SdkResponse = { statusCode: number; headers: Record<string, string>; body: unknown };

/**
 * Run an SDK call and return PayPal's raw JSON (snake_case, exactly as sent), not the SDK's
 * camelCase model. API errors come back as responses; network errors retry, then throw
 * PayPalNetworkError without any request details.
 */
export async function callSdk(label: string, call: () => Promise<SdkResponse>): Promise<PPResponse> {
  const r = await withRetry(label, async () => {
    try {
      return await call();
    } catch (e) {
      if (e instanceof ApiError) return e as SdkResponse;
      throw e;
    }
  });
  const body = typeof r.body === 'string' ? parseBody(r.body) : r.body;
  return { status: r.statusCode, headers: r.headers ?? {}, debugId: r.headers?.['paypal-debug-id'], body };
}
