import { createAnthropic } from '@ai-sdk/anthropic';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createOpenAI } from '@ai-sdk/openai';
import { APICallError, generateText, Output, RetryError, type LanguageModel } from 'ai';
import type { z } from 'zod';
import { ConfigError, env, required } from '../../config';

export const PROVIDERS = ['gemini', 'openai', 'anthropic'] as const;
export type Provider = (typeof PROVIDERS)[number];

type Candidate = { model: LanguageModel; provider: Provider; modelId: string; role: 'primary' | 'fallback' };

function build(provider: Provider, apiKey: string, modelId: string): LanguageModel {
  switch (provider) {
    case 'gemini':
      return createGoogleGenerativeAI({ apiKey })(modelId);
    case 'openai':
      return createOpenAI({ apiKey })(modelId);
    case 'anthropic':
      return createAnthropic({ apiKey })(modelId);
  }
}

/** AI_MODEL, then AI_FALLBACK_MODEL if set, both on AI_PROVIDER with AI_API_KEY. */
export function candidateModels(): Candidate[] {
  const provider = env('AI_PROVIDER')?.toLowerCase() as Provider | undefined;
  if (!provider || !PROVIDERS.includes(provider)) throw new ConfigError(`AI_PROVIDER must be one of ${PROVIDERS.join(', ')}`);
  const apiKey = required('AI_API_KEY');
  const primary = required('AI_MODEL');
  const out: Candidate[] = [{ model: build(provider, apiKey, primary), provider, modelId: primary, role: 'primary' }];
  const fallback = env('AI_FALLBACK_MODEL');
  if (fallback && fallback !== primary) out.push({ model: build(provider, apiKey, fallback), provider, modelId: fallback, role: 'fallback' });
  return out;
}

/** Why a model failed, in a few words; and whether that failure should move on to the fallback model. */
export function classifyLlmError(e: unknown): { fallback: boolean; reason: string } {
  const last = RetryError.isInstance(e) ? e.lastError : e;
  const err = last as { name?: string; message?: string };
  if (err?.name === 'TimeoutError' || err?.name === 'AbortError') return { fallback: true, reason: 'timeout' };
  if (APICallError.isInstance(last)) {
    const status = last.statusCode ?? 0;
    const overloaded = status === 429 || status === 503 || /high demand|overload|UNAVAILABLE|RESOURCE_EXHAUSTED/i.test(last.message);
    if (overloaded) return { fallback: true, reason: `overloaded (HTTP ${status || '?'})` };
    if (status >= 500) return { fallback: true, reason: `server error HTTP ${status}` };
    return { fallback: false, reason: `HTTP ${status}: ${last.message.slice(0, 120)}` };
  }
  return { fallback: false, reason: String(err?.message ?? e).slice(0, 120) };
}

export type ObjectResult<T> = { output: T; provider: Provider; modelId: string; fallbackUsed: boolean; primaryFailure?: string };

/**
 * Structured output with automatic fallback. Each model gets one retry (the AI SDK retries
 * retryable API errors once). If the primary still fails because it is overloaded, returns a 5xx or
 * times out, the same request goes to AI_FALLBACK_MODEL. Any other error (bad key, invalid request,
 * schema mismatch) is thrown as is. Logs which model answered.
 */
export async function generateObjectWithFallback<S extends z.ZodType>(opts: {
  task: string;
  system: string;
  prompt: string;
  schema: S;
  timeoutMs?: number;
}): Promise<ObjectResult<z.infer<S>>> {
  const candidates = candidateModels();
  let primaryFailure: string | undefined;
  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i];
    const started = Date.now();
    try {
      const result = await generateText({
        model: c.model,
        system: opts.system,
        prompt: opts.prompt,
        output: Output.object({ schema: opts.schema }),
        maxRetries: 1,
        abortSignal: AbortSignal.timeout(opts.timeoutMs ?? 40_000),
      });
      console.log(
        `llm ${opts.task}: answered by ${c.provider}/${c.modelId} (${c.role}) in ${Date.now() - started} ms` +
          (primaryFailure ? `; primary ${candidates[0].modelId} failed: ${primaryFailure}` : ''),
      );
      return { output: result.output as z.infer<S>, provider: c.provider, modelId: c.modelId, fallbackUsed: c.role === 'fallback', primaryFailure };
    } catch (e) {
      const why = classifyLlmError(e);
      console.error(`llm ${opts.task}: ${c.provider}/${c.modelId} (${c.role}) failed after one retry: ${why.reason}`);
      if (i === 0) primaryFailure = why.reason;
      if (!why.fallback || i === candidates.length - 1) throw e;
    }
  }
  throw new Error('unreachable');
}
