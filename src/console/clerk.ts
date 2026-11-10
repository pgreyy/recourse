import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { env } from '../config';
import { reserveAiCall } from '../shared/ai/budget';
import { HttpError } from '../shared/http/errors';

/**
 * The Clerk's model turn. AG Studio's agent loop runs in the browser and calls this with one turn
 * (conversation, instructions, tool schemas); we forward it to OpenAI's Responses API with the key
 * kept server-side and return the output items. The model is fixed here (AI_CLERK_MODEL, default the
 * nano model), whatever the page asks for. This endpoint executes no tools: the Clerk's tools run in
 * the browser and are all read-only GETs. No money-moving tool exists.
 */

const Item = z.object({ type: z.string() }).passthrough();
export const ClerkTurn = z.object({
  input: z.array(Item).max(200),
  instructions: z.string().max(20000).optional(),
  tools: z.array(z.object({ name: z.string(), description: z.string(), parameters: z.record(z.string(), z.unknown()) }).passthrough()).max(20).optional(),
  toolChoice: z.union([z.enum(['auto', 'none', 'required']), z.object({ name: z.string() })]).optional(),
  responseFormat: z.object({ type: z.enum(['text', 'json']), name: z.string().optional(), schema: z.record(z.string(), z.unknown()).optional() }).passthrough().optional(),
});

const textOf = (content: unknown): string =>
  Array.isArray(content) ? content.map((c: any) => c?.text ?? c?.refusal ?? '').join('') : typeof content === 'string' ? content : '';

/** Studio's conversation items -> Responses API input items. Reasoning items and item ids are not sent back. */
function toOpenAiInput(items: any[]) {
  const out: any[] = [];
  for (const it of items) {
    if (it.type === 'message' && (it.role === 'user' || it.role === 'system')) {
      out.push({ role: it.role === 'system' ? 'developer' : 'user', content: textOf(it.content) });
    } else if (it.type === 'message' && it.role === 'assistant') {
      const text = textOf(it.content);
      if (text) out.push({ role: 'assistant', content: text });
    } else if (it.type === 'function_call') {
      out.push({ type: 'function_call', call_id: it.callId, name: it.name, arguments: it.arguments ?? '{}' });
    } else if (it.type === 'function_call_output') {
      out.push({ type: 'function_call_output', call_id: it.callId, output: String(it.output ?? '').slice(0, 60000) });
    }
  }
  return out;
}

export async function clerkTurn(body: z.infer<typeof ClerkTurn>) {
  const key = env('OPENAI_API_KEY');
  if (!key) throw new HttpError(503, 'CLERK_NOT_CONFIGURED', 'OPENAI_API_KEY is not set.');
  const model = env('AI_CLERK_MODEL') || 'gpt-5-nano';
  const request: Record<string, unknown> = {
    model,
    input: toOpenAiInput(body.input),
    instructions: body.instructions,
    store: false,
    reasoning: { effort: 'low' },
    max_output_tokens: 4000,
  };
  if (body.tools?.length) {
    request.tools = body.tools.map((t) => ({ type: 'function', name: t.name, description: t.description, parameters: t.parameters, strict: false }));
    request.tool_choice = typeof body.toolChoice === 'object' ? { type: 'function', name: body.toolChoice.name } : (body.toolChoice ?? 'auto');
  }
  if (body.responseFormat?.type === 'json' && body.responseFormat.schema) {
    request.text = { format: { type: 'json_schema', name: body.responseFormat.name ?? 'answer', schema: body.responseFormat.schema, strict: false } };
  }
  reserveAiCall();
  const started = Date.now();
  const r = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify(request),
    signal: AbortSignal.timeout(90_000),
  });
  const j: any = await r.json().catch(() => ({}));
  if (!r.ok) {
    console.log(`[clerk] ${model} HTTP ${r.status} ${j?.error?.code ?? ''}`);
    return { id: randomUUID(), createdAt: Date.now(), status: 'failed', output: [], error: { code: String(j?.error?.code ?? r.status), message: String(j?.error?.message ?? 'model call failed') }, model };
  }
  const output: any[] = [];
  for (const o of j.output ?? []) {
    if (o.type === 'message') {
      const text = textOf(o.content);
      if (text) output.push({ id: o.id ?? randomUUID(), kind: 'output', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'text', text, annotations: [] }] });
    } else if (o.type === 'function_call') {
      output.push({ id: o.id ?? randomUUID(), kind: 'output', type: 'function_call', callId: o.call_id, name: o.name, arguments: o.arguments ?? '{}', status: 'completed' });
    }
  }
  console.log(`[clerk] ${model} ${Date.now() - started}ms out=${output.map((o) => o.type === 'function_call' ? `call:${o.name}` : 'text').join(',')} tokens=${j.usage?.total_tokens ?? '?'}`);
  return {
    id: j.id ?? randomUUID(),
    createdAt: Date.now(),
    status: j.status === 'incomplete' ? 'incomplete' : 'completed',
    incompleteDetails: j.incomplete_details ?? undefined,
    output,
    model: `openai/${model}`,
  };
}
