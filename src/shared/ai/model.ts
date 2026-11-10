import { createAnthropic } from '@ai-sdk/anthropic';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createOpenAI } from '@ai-sdk/openai';
import { APICallError, generateText, Output, RetryError, type LanguageModel } from 'ai';
import type { z } from 'zod';
import { ConfigError, env, required } from '../../config';

export const PROVIDERS = ['gemini', 'openai', 'anthropic'] as const;
export type Provider = (typeof PROVIDERS)[number];

export type Candidate = {
  model: LanguageModel;
  provider: Provider;
  modelId: string;
  /** 'primary', 'fallback 1', 'fallback 2', ... */
  role: string;
  /** Provider-specific options, e.g. minimal reasoning effort for OpenAI reasoning models. */
  providerOptions?: Record<string, Record<string, string | number | boolean>>;
};

function build(provider: Provider, apiKey: string, modelId: string): Omit<Candidate, 'role'> {
  switch (provider) {
    case 'gemini':
      return { model: createGoogleGenerativeAI({ apiKey })(modelId), provider, modelId };
    case 'openai':
      return {
        model: createOpenAI({ apiKey })(modelId),
        provider,
        modelId,
        // gpt-5* and o* are reasoning models: keep reasoning minimal so calls stay cheap and fast.
        providerOptions: /^(gpt-5|o\d)/.test(modelId) ? { openai: { reasoningEffort: 'minimal' } } : undefined,
      };
    case 'anthropic':
      return { model: createAnthropic({ apiKey })(modelId), provider, modelId };
  }
}

/**
 * The model chain, in the order they are tried.
 *   Main provider (AI_PROVIDER, AI_API_KEY): AI_MODEL, then AI_FALLBACK_MODEL.
 *   OpenAI (OPENAI_API_KEY, AI_OPENAI_MODEL): last resort by default; first when AI_PRIMARY=openai.
 */
export function candidateModels(): Candidate[] {
  const provider = env('AI_PROVIDER')?.toLowerCase() as Provider | undefined;
  if (!provider || !PROVIDERS.includes(provider)) throw new ConfigError(`AI_PROVIDER must be one of ${PROVIDERS.join(', ')}`);
  const apiKey = required('AI_API_KEY');
  const main: Array<Omit<Candidate, 'role'>> = [build(provider, apiKey, required('AI_MODEL'))];
  const fallback = env('AI_FALLBACK_MODEL');
  if (fallback && fallback !== main[0].modelId) main.push(build(provider, apiKey, fallback));

  const openaiKey = env('OPENAI_API_KEY');
  const openaiModel = env('AI_OPENAI_MODEL');
  const openai = openaiKey && openaiModel ? [build('openai', openaiKey, openaiModel)] : [];

  const primary = (env('AI_PRIMARY') ?? provider).toLowerCase();
  if (primary === 'openai' && !openai.length) throw new ConfigError('AI_PRIMARY=openai needs OPENAI_API_KEY and AI_OPENAI_MODEL');
  const ordered = primary === 'openai' ? [...openai, ...main] : [...main, ...openai];
  return ordered.map((c, i) => ({ ...c, role: i === 0 ? 'primary' : `fallback ${i}` }));
}

/** Why a model failed, in a few words; and whether that failure should move on to the next model. */
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

export type Answered = { provider: Provider; modelId: string; role: string; fallbackUsed: boolean; failures: string[] };

/**
 * Run `fn` against each model in the chain until one answers. Each model gets one retry inside `fn`
 * (maxRetries: 1). A model that is still overloaded, returns a 5xx or times out hands over to the
 * next; any other error is thrown as is. `canFallback` lets a caller refuse to switch models once
 * something irreversible has happened (e.g. an agent already created a cart). Logs who answered.
 */
export async function runWithFallback<T>(
  task: string,
  fn: (c: Candidate) => Promise<T>,
  opts: { canFallback?: () => boolean; only?: Provider; first?: { provider: Provider; modelId: string } } = {},
): Promise<{ value: T } & Answered> {
  let chain = candidateModels().filter((c) => !opts.only || c.provider === opts.only);
  if (opts.first) {
    // A task-specific model goes first (e.g. AI_ASSESS_MODEL for case assessments); the normal chain follows.
    const key = opts.first.provider === 'openai' ? env('OPENAI_API_KEY') : env('AI_API_KEY');
    if (!key) throw new ConfigError(`no API key for ${opts.first.provider}`);
    const first = { ...build(opts.first.provider, key, opts.first.modelId), role: 'primary' };
    chain = [first, ...chain.filter((c) => !(c.provider === first.provider && c.modelId === first.modelId)).map((c, i) => ({ ...c, role: `fallback ${i + 1}` }))];
  }
  if (!chain.length) throw new ConfigError(`no configured model for provider ${opts.only}`);
  const failures: string[] = [];
  for (let i = 0; i < chain.length; i++) {
    const c = chain[i];
    const started = Date.now();
    try {
      const value = await fn(c);
      console.log(
        `llm ${task}: answered by ${c.provider}/${c.modelId} (${c.role}) in ${Date.now() - started} ms` +
          (failures.length ? `; earlier: ${failures.join('; ')}` : ''),
      );
      return { value, provider: c.provider, modelId: c.modelId, role: c.role, fallbackUsed: i > 0, failures };
    } catch (e) {
      const why = classifyLlmError(e);
      console.error(`llm ${task}: ${c.provider}/${c.modelId} (${c.role}) failed after one retry: ${why.reason}`);
      failures.push(`${c.modelId}: ${why.reason}`);
      const last = i === chain.length - 1;
      if (!why.fallback || last || (opts.canFallback && !opts.canFallback())) throw e;
    }
  }
  throw new Error('unreachable');
}

export type ObjectResult<T> = { output: T } & Answered;

/** Structured output through the model chain. */
export async function generateObjectWithFallback<S extends z.ZodType>(opts: {
  task: string;
  system: string;
  prompt: string;
  schema: S;
  timeoutMs?: number;
  /** Reasoning effort for OpenAI reasoning models (default: the candidate's, i.e. minimal). */
  openaiEffort?: 'minimal' | 'low' | 'medium';
  /** A task-specific model to try first. */
  first?: { provider: Provider; modelId: string };
}): Promise<ObjectResult<z.infer<S>>> {
  const r = await runWithFallback(opts.task, async (c) => {
    const result = await generateText({
      model: c.model,
      system: opts.system,
      prompt: opts.prompt,
      output: Output.object({ schema: opts.schema }),
      maxRetries: 1,
      abortSignal: AbortSignal.timeout(opts.timeoutMs ?? 40_000),
      providerOptions:
        opts.openaiEffort && c.provider === 'openai' && c.providerOptions ? { openai: { ...c.providerOptions.openai, reasoningEffort: opts.openaiEffort } } : c.providerOptions,
    });
    return result.output as z.infer<S>;
  }, { first: opts.first });
  const { value, ...answered } = r;
  return { output: value, ...answered };
}
