import { env } from '../../config';
import { HttpError } from '../http/errors';

/**
 * Credit protection for the public demo: a global cap on model calls per rolling hour
 * (AI_CALLS_PER_HOUR, default 60) and a per-IP cap on agent runs (AGENT_RUNS_PER_IP_PER_HOUR, default 3).
 * In memory, so it resets when the service restarts; the demo runs as one instance.
 */
const HOUR = 3_600_000;
let calls: number[] = [];
const runsByIp = new Map<string, number[]>();

const prune = (xs: number[]) => xs.filter((t) => t > Date.now() - HOUR);
const limit = () => Math.max(1, Number(env('AI_CALLS_PER_HOUR', '60')) || 60);

export const DEMO_LIMIT_MESSAGE = 'Demo limit reached: this public demo allows a set number of AI calls per hour. Please try again later.';

function demoLimit(retryAfterMs: number) {
  return new HttpError(429, 'DEMO_LIMIT', DEMO_LIMIT_MESSAGE, { retry_after_seconds: Math.ceil(retryAfterMs / 1000) });
}

export function aiBudget() {
  calls = prune(calls);
  return { used: calls.length, limit: limit(), remaining: Math.max(0, limit() - calls.length), window: '1 hour' };
}

/** Throw 429 unless `n` more model calls fit in the hour. Does not count them. */
export function requireAiBudget(n = 1) {
  calls = prune(calls);
  if (calls.length + n > limit()) throw demoLimit((calls[0] ?? Date.now()) + HOUR - Date.now());
}

/** Count one model call, refusing it if the hour's budget is used up. */
export function reserveAiCall() {
  requireAiBudget(1);
  calls.push(Date.now());
}

/** Count calls that already happened (extra steps of a multi-step agent run). */
export function recordAiCalls(n: number) {
  for (let i = 0; i < n; i++) calls.push(Date.now());
}

export function reserveAgentRun(ip: string) {
  const cap = Math.max(1, Number(env('AGENT_RUNS_PER_IP_PER_HOUR', '3')) || 3);
  const xs = prune(runsByIp.get(ip) ?? []);
  if (xs.length >= cap) {
    throw new HttpError(429, 'DEMO_LIMIT', `Demo limit reached: ${cap} agent runs per hour from one address. Please try again later.`, {
      retry_after_seconds: Math.ceil((xs[0] + HOUR - Date.now()) / 1000),
    });
  }
  xs.push(Date.now());
  runsByIp.set(ip, xs);
}
