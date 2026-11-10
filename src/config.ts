import 'dotenv/config';
import './shared/net';

/** Thrown when a setting a feature needs is missing. Routes turn it into 503 with the setting's name. */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

export function env(name: string, fallback?: string): string | undefined {
  const v = process.env[name];
  return v === undefined || v.trim() === '' ? fallback : v.trim();
}

export function required(name: string): string {
  const v = env(name);
  if (!v) throw new ConfigError(`${name} is not set in .env`);
  return v;
}

export const config = {
  // Render (RENDER=true) tells the service which port to bind in PORT; locally APP_PORT, default 3000.
  appPort: () => Number(env('RENDER') ? env('PORT', '10000') : env('APP_PORT', '3000')),
  /** Base URL PayPal redirects the browser back to after an approval. */
  /** Every PayPal return and cancel URL, receipt link and the webhook URL derive from this. On Render,
   *  RENDER_EXTERNAL_URL is the fallback until PUBLIC_BASE_URL is set. */
  publicBaseUrl: () => (env('PUBLIC_BASE_URL') || env('RENDER_EXTERNAL_URL') || `http://localhost:${env('APP_PORT', '3000')}`).replace(/\/$/, ''),
  databaseUrl: () => required('DATABASE_URL'),
  signingKey: () => required('RECOURSE_SIGNING_KEY'),
  currency: () => env('CURRENCY', 'USD')!,
};
