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

const MOVE_MONEY = /^\s*(please\s+)?(refund|charge|pay|settle|reimburse)\b|\b(can|could|will) you (refund|charge|pay|settle|reimburse)\b/i;
const MONEY_WORDS = /\b(refund\w*|charg\w*|recover\w*|settle\w*|paid|payout|reimburs\w*)\b/i;
const NEGATION = /\b(no|not|never|cannot|can't|isn't|wasn't|hasn't|has not|have not|was not|is not|nothing|none|neither)\b/i;
const CLAIMS_REFUND = /\b(refund(ed)?\b[^.]{0,80}\b(issued|on its way|processed|processing|will be|being|has been|was|authori[sz]ed|coming|approved)|(was|been|is being|will be|be)\s+refunded)\b/i;

/** The tool results of the current question: everything after the user's last message. */
function toolOutputsThisAnswer(items: any[]): string[] {
  let last = -1;
  items.forEach((it, i) => {
    if (it.type === 'message' && it.role === 'user') last = i;
  });
  return items.slice(last + 1).filter((it) => it.type === 'function_call_output').map((it) => String(it.output ?? ''));
}

/**
 * Money-facts check, in code: an answer that talks about refunds, charges, recovery or settlement may only
 * state amounts, PayPal ids, statuses and refund claims that appear in this answer's tool results.
 * Returns the problems found (empty when the answer passes).
 */
export function moneyFactProblems(answer: string, outputs: string[], question = ''): string[] {
  const problems: string[] = [];
  // A request to refund, charge or settle must be refused: the Clerk cannot move money.
  if (MOVE_MONEY.test(question) && !/\b(can't|cannot|can not|am not able|unable)\b/i.test(answer)) {
    problems.push('the user asked to move money; the answer must say plainly that you cannot do that');
  }
  if (MOVE_MONEY.test(question)) {
    // Say why, from the ruling, and do not offer a proposal: there is no way to propose a refund.
    const verdicts = [...new Set([...outputs.join('\n').matchAll(/"verdict":"([A-Z_]+)"/g)].map((m) => m[1]))];
    const words = (v: string) => v.toLowerCase().replace(/_/g, ' ').replace('buyer remorse', 'remorse');
    if (verdicts.length && !verdicts.some((v) => answer.includes(v) || answer.toLowerCase().includes(words(v)))) problems.push(`the refusal must say why, naming the ruling (${verdicts.join(', ')})`);
    if (/\bpropos/i.test(answer)) problems.push('there is no way to propose a refund; do not offer a proposal');
  }
  if (!MONEY_WORDS.test(answer)) return problems;
  const all = outputs.join('\n');
  if (!outputs.length) return [...problems, 'it states money facts without any tool result in this answer'];
  const toolSaysNoSettlement = /No settlement exists/.test(all);
  const toolSaysNoRefund = /No refund has been issued/.test(all);
  if (/no settlement/i.test(answer) && !toolSaysNoSettlement && /\bno settlement (exists|was|has|for)\b/i.test(answer)) problems.push('it says no settlement exists, but the tool results do not say that');
  for (const amt of answer.match(/\b\d{1,7}\.\d{2}\b/g) ?? []) if (!all.includes(amt)) problems.push(`amount ${amt} is not in the tool results`);
  for (const id of answer.match(/\b(?=[0-9A-Z]*\d)(?=[0-9A-Z]*[A-Z])[0-9A-Z]{17}\b|\bPP-[A-Z]-[A-Z]{3}-\d+\b/g) ?? []) if (!all.includes(id)) problems.push(`PayPal id ${id} is not in the tool results`);
  const refunded = /REFUND_BUYER SUCCEEDED|"action":"REFUND_BUYER","status":"SUCCEEDED"|Refunded \d/.test(all);
  for (const sentence of answer.split(/(?<=[.!?])\s+|\n+/)) {
    if (CLAIMS_REFUND.test(sentence) && !NEGATION.test(sentence) && !refunded) problems.push(`it says a refund happened or is coming, but the tool results show no refund ("${sentence.trim().slice(0, 120)}")`);
  }
  // It must quote a settlement status from the tool results, or say that no settlement exists.
  const statuses = [...new Set([...all.matchAll(/(?:settlement status |"status":"|"settlement_status":")([A-Z_]{4,})/g)].map((m) => m[1]))];
  const norm = (x: string) => x.toLowerCase().replace(/_/g, ' ');
  const quoted = statuses.some((st) => answer.includes(st) || norm(answer).includes(norm(st)));
  if (!quoted && !(toolSaysNoSettlement && /no settlement/i.test(answer))) problems.push('it does not quote the settlement status from the tool results (call get_case or get_settlements for it), or say that no settlement exists when a tool says so');
  // And a PayPal id, when the tool results have one.
  const ids = [...new Set(all.match(/\b(?=[0-9A-Z]*\d)(?=[0-9A-Z]*[A-Z])[0-9A-Z]{17}\b|\bPP-[A-Z]-[A-Z]{3}-\d+\b/g) ?? [])];
  if (ids.length && !ids.some((id) => answer.includes(id)) && !(toolSaysNoSettlement && /no settlement/i.test(answer))) problems.push('it does not quote a PayPal id from the tool results');
  void toolSaysNoRefund;
  return problems;
}

function lastUserText(items: any[]): string {
  const u = [...items].reverse().find((it) => it.type === 'message' && it.role === 'user');
  return u ? textOf(u.content) : '';
}

/** When an answer fails twice: the code-written money facts from the tool results, quoted as they are. */
const VERDICT_WORDS: Record<string, string> = { AGENT_FAULT: 'agent fault', MERCHANT_FAULT: 'merchant fault', BUYER_REMORSE: "buyer's remorse", THIRD_PARTY_FAULT: 'third-party fault', INCONCLUSIVE: 'inconclusive' };

function factsFallback(outputs: string[], question = ''): string {
  const lines: string[] = [];
  const rulings: string[] = [];
  const walk = (x: any, ref?: string) => {
    if (!x || typeof x !== 'object') return;
    const r = x.case_ref ?? ref;
    if (x.money_facts) lines.push(`${r ? `${r}: ` : ''}${Object.values(x.money_facts).join(' ')}`);
    if (x.ruling?.verdict && r) rulings.push(`The approved decision for ${r} is ${VERDICT_WORDS[x.ruling.verdict] ?? x.ruling.verdict}${x.ruling.verdict === 'BUYER_REMORSE' ? ', so under the decision no refund is due from Recourse; any change would come from PayPal’s own dispute decision' : ''}.`);
    for (const v of Object.values(x)) walk(v, r);
  };
  for (const o of outputs) {
    try {
      walk(JSON.parse(o));
    } catch {
      /* not JSON */
    }
  }
  const refusal = MOVE_MONEY.test(question) ? `I can't refund, charge or settle anything. ${[...new Set(rulings)].join(' ')}\n\n` : '';
  return lines.length
    ? `${refusal}${refusal ? 'The settlement records say' : 'I could not state that reliably, so here are the settlement records as they are'}:\n\n${[...new Set(lines)].map((l) => `- ${l}`).join('\n')}`
    : "I could not state that reliably from the settlement records. Open the case's Settlement panel for the confirmed PayPal ids.";
}

export async function clerkTurn(body: z.infer<typeof ClerkTurn>) {
  const first = await clerkModelTurn(body);
  const text = first.output.find((o: any) => o.type === 'message')?.content?.[0]?.text as string | undefined;
  if (!text || first.output.some((o: any) => o.type === 'function_call')) return first;
  const outputs = toolOutputsThisAnswer(body.input);
  const question = lastUserText(body.input);
  const problems = moneyFactProblems(text, outputs, question);
  if (!problems.length) return first;
  console.log(`[clerk] money-facts check failed: ${problems.join('; ')}`);
  // One retry, told exactly what failed.
  const retry = await clerkModelTurn({
    ...body,
    input: [
      ...body.input,
      { type: 'message', role: 'assistant', content: text },
      { type: 'message', role: 'system', content: `Your answer failed the money-facts check: ${problems.join('; ')}. Rewrite it. Every statement about refunds, charges, recovery or settlement must quote the settlement status and PayPal id exactly as the tool results above give them, or say that no settlement exists or no refund has been issued. State nothing that is not in those results. If the facts you need are not there, call get_case or get_settlements first.${/must say plainly/.test(problems.join()) ? ' Begin with: "I can\'t refund, charge or settle anything."' : ''}` },
    ],
  });
  // The retry may fetch the missing facts first; the harness runs the tool and the next answer is checked again.
  if (retry.output.some((o: any) => o.type === 'function_call')) return retry;
  const text2 = retry.output.find((o: any) => o.type === 'message')?.content?.[0]?.text as string | undefined;
  const problems2 = text2 ? moneyFactProblems(text2, outputs, question) : ['no answer'];
  if (text2 && !problems2.length) return { ...retry, output: retry.output.filter((o: any) => o.type === 'message') };
  console.log(`[clerk] money-facts check failed again: ${problems2.join('; ')}; answering with the recorded facts`);
  const msg = first.output.find((o: any) => o.type === 'message');
  return { ...first, output: [{ ...msg, content: [{ type: 'text', text: factsFallback(outputs, question), annotations: [] }] }] };
}

async function clerkModelTurn(body: z.infer<typeof ClerkTurn>) {
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
