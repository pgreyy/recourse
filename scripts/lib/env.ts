import 'dotenv/config';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

// Phase 0 talks to the sandbox only. There is deliberately no switch to live.
export const API_BASE = 'https://api-m.sandbox.paypal.com';

export const LOCAL_DIR = resolve(process.cwd(), '.local');
const STATE_FILE = resolve(LOCAL_DIR, 'state.json');

/** Read an env var; empty strings count as unset. */
export function env(name: string, fallback?: string): string | undefined {
  const v = process.env[name];
  return v === undefined || v.trim() === '' ? fallback : v.trim();
}

/** Read a required env var or exit with a clear message. */
export function need(name: string): string {
  const v = env(name);
  if (!v) {
    console.error(`Missing ${name}. Copy .env.example to .env and fill it in.`);
    process.exit(1);
  }
  return v;
}

type State = Record<string, string>;

function readState(): State {
  if (!existsSync(STATE_FILE)) return {};
  return JSON.parse(readFileSync(STATE_FILE, 'utf8')) as State;
}

/**
 * Values handed from one probe to the next (vault ids, order ids, dispute ids).
 * An env var of the same name wins over the saved value.
 */
export function getValue(name: string): string | undefined {
  return env(name) ?? readState()[name];
}

export function requireValue(name: string, hint: string): string {
  const v = getValue(name);
  if (!v) {
    console.error(`No ${name} yet. ${hint}`);
    process.exit(1);
  }
  return v;
}

export function saveValues(values: Record<string, string | undefined>): void {
  const state = readState();
  for (const [k, v] of Object.entries(values)) if (v) state[k] = v;
  mkdirSync(dirname(STATE_FILE), { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2) + '\n');
  const shown = Object.entries(values).filter(([, v]) => v);
  if (shown.length) {
    console.log('\nSaved to .local/state.json:');
    for (const [k, v] of shown) console.log(`  ${k}=${v}`);
  }
}

/** Positional args, ignoring --flags. */
export function args(): string[] {
  return process.argv.slice(2).filter((a) => !a.startsWith('--'));
}

export function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

export function currency(): string {
  return env('CURRENCY', 'USD')!;
}
