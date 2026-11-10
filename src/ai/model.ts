import { createAnthropic } from '@ai-sdk/anthropic';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createOpenAI } from '@ai-sdk/openai';
import type { LanguageModel } from 'ai';
import { ConfigError, env, required } from '../config';

export const PROVIDERS = ['gemini', 'openai', 'anthropic'] as const;
export type Provider = (typeof PROVIDERS)[number];

/** The language model chosen by AI_PROVIDER / AI_MODEL / AI_API_KEY. */
export function languageModel(): { model: LanguageModel; provider: Provider; modelId: string } {
  const provider = env('AI_PROVIDER')?.toLowerCase() as Provider | undefined;
  if (!provider || !PROVIDERS.includes(provider)) {
    throw new ConfigError(`AI_PROVIDER must be one of ${PROVIDERS.join(', ')}`);
  }
  const modelId = required('AI_MODEL');
  const apiKey = required('AI_API_KEY');
  switch (provider) {
    case 'gemini':
      return { model: createGoogleGenerativeAI({ apiKey })(modelId), provider, modelId };
    case 'openai':
      return { model: createOpenAI({ apiKey })(modelId), provider, modelId };
    case 'anthropic':
      return { model: createAnthropic({ apiKey })(modelId), provider, modelId };
  }
}
