// Probe wrappers around src/paypal/sdk: same exports as before, and every call is printed.
import './env';
import { callSdk, sdk } from '../../src/paypal/sdk';
import type { PPResponse } from '../../src/paypal/types';
import { exitOnPayPalError } from './http';
import { show } from './print';

export const { client, vault, orders, payments } = sdk();

type SdkResponse = { statusCode: number; headers: Record<string, string>; body: unknown };

/** Run an SDK call, print PayPal's raw JSON, and exit cleanly on network errors. */
export async function sdkCall(label: string, call: () => Promise<SdkResponse>): Promise<PPResponse> {
  return show(label, await exitOnPayPalError(callSdk(label, call)));
}

/** Print a response from a src/paypal helper that already made the call. */
export async function printed(label: string, p: Promise<PPResponse>): Promise<PPResponse> {
  return show(label, await exitOnPayPalError(p));
}
