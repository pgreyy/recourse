import { generateText, Output } from 'ai';
import { languageModel } from '../ai/model';
import { LlmMandate } from './spec';

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function systemPrompt(now: Date): string {
  const today = now.toISOString().slice(0, 10);
  return [
    'You turn a shopper\'s plain-English purchase instruction into a structured mandate that limits what a shopping agent may buy.',
    `Today is ${WEEKDAYS[now.getUTCDay()]} ${today} (UTC).`,
    'Rules:',
    '- Use only what the text says. Never invent brands, merchants, sizes or limits.',
    '- max_total: the stated price ceiling ("under $120" means 120.00). "$" means USD unless the text names another currency.',
    '- Sizes keep their system exactly as written: "US men\'s 10" gives {name:"size", value:"10", unit_system:"US"} plus {name:"gender", value:"men", unit_system:null}. Never convert between size systems. If the text gives a size without a system, set unit_system to null.',
    '- deadline: a weekday name means the next such day on or after today; "by Friday" means that Friday. Use YYYY-MM-DD.',
    '- brands_allowed: every brand the text accepts ("Nike or Asics" gives both). Empty list if any brand is fine.',
    '- merchants_allowed: null unless the text names stores.',
    '- quantity: 1 unless the text says otherwise.',
  ].join('\n');
}

/** Ask the configured LLM to structure the text. Returns the raw LLM object (validated later). */
export async function parseMandateText(text: string): Promise<{ draft: LlmMandate; provider: string; modelId: string }> {
  const { model, provider, modelId } = languageModel();
  const result = await generateText({
    model,
    system: systemPrompt(new Date()),
    prompt: text,
    output: Output.object({ schema: LlmMandate }),
    maxRetries: 1,
    abortSignal: AbortSignal.timeout(45_000),
  });
  return { draft: result.output, provider, modelId };
}
