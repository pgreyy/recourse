// Probe wrappers around src/paypal/http. Same exports as before; on a network or auth failure
// the probes print one safe line and exit instead of throwing.
import './env';
import * as core from '../../src/paypal/http';
import { PayPalApiError, PayPalNetworkError, type PPResponse } from '../../src/paypal/types';

export { multipart, requestId, RETRYABLE, type CallOptions, type Part } from '../../src/paypal/http';

export async function exitOnPayPalError<T>(p: Promise<T>): Promise<T> {
  try {
    return await p;
  } catch (e) {
    if (e instanceof PayPalNetworkError || e instanceof PayPalApiError) {
      console.error(e.message);
      process.exit(1);
    }
    if (e instanceof Error && e.message.includes('must be set in .env')) {
      console.error(e.message);
      process.exit(1);
    }
    throw e;
  }
}

export const requestToken = (): Promise<PPResponse> => exitOnPayPalError(core.requestToken());
export const accessToken = (): Promise<string> => exitOnPayPalError(core.accessToken());
export const pp = (method: string, path: string, opts?: core.CallOptions): Promise<PPResponse> =>
  exitOnPayPalError(core.pp(method, path, opts));
export const authAssertion = (email: string): string => core.authAssertion(email);
