/** A PayPal API response with the raw JSON body, exactly as PayPal sent it (snake_case). */
export type PPResponse = {
  status: number;
  debugId?: string;
  headers: Record<string, string>;
  body: any;
};

/**
 * Network failure talking to PayPal after retries. Carries only the error code and a label,
 * never the request: SDK and fetch errors can hold the Basic auth header with the client secret.
 */
export class PayPalNetworkError extends Error {
  constructor(
    readonly label: string,
    readonly code: string,
  ) {
    super(`${label}: network error ${code}`);
    this.name = 'PayPalNetworkError';
  }
}

/** PayPal answered, but not with what the caller needed. Holds the status, PayPal's error name and debug id. */
export class PayPalApiError extends Error {
  constructor(
    readonly label: string,
    readonly response: PPResponse,
  ) {
    const b = response.body ?? {};
    super(`${label}: HTTP ${response.status} ${b.name ?? b.error ?? ''} ${b.message ?? b.error_description ?? ''}`.trim());
    this.name = 'PayPalApiError';
  }

  /** Safe summary for API clients: no headers, just PayPal's error body and debug id. */
  toJSON() {
    return { label: this.label, status: this.response.status, debug_id: this.response.debugId, paypal: this.response.body };
  }
}

export function parseBody(text: string): any {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** Throw PayPalApiError unless the response is 2xx. */
export function expectOk(label: string, res: PPResponse): PPResponse {
  if (res.status < 200 || res.status >= 300) throw new PayPalApiError(label, res);
  return res;
}
