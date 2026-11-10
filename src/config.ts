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
  appPort: () => Number(env('APP_PORT', '3000')),
  /** Base URL PayPal redirects the browser back to after an approval. */
  publicBaseUrl: () => env('PUBLIC_BASE_URL', `http://localhost:${env('APP_PORT', '3000')}`)!.replace(/\/$/, ''),
  databaseUrl: () => required('DATABASE_URL'),
  signingKey: () => required('RECOURSE_SIGNING_KEY'),
  currency: () => env('CURRENCY', 'USD')!,
};
