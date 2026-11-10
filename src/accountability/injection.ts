/**
 * Injection guard (source: "code"): finds instruction-like text anywhere in a case's evidence. The text
 * stays in the evidence (it is part of what happened), marked untrusted; the case shows a flag saying
 * it was ignored. Nothing here decides the case.
 */
const PATTERNS: Array<[string, RegExp]> = [
  ['ignore-instructions', /\b(ignore|disregard|forget|override)\b[^.\n]{0,40}\b(previous|prior|above|earlier|all|your|system)\b[^.\n]{0,20}\b(instructions?|prompts?|rules?)\b/i],
  ['verdict-directive', /\b(return|output|answer|rule|respond( with)?|set (the )?verdict( to)?|verdict\s*[:=])\s*["'`]?(AGENT_FAULT|MERCHANT_FAULT|BUYER_REMORSE|THIRD_PARTY_FAULT|INCONCLUSIVE)\b/i],
  ['role-override', /\b(you are now|act as|pretend (to be|you are)|new instructions|system prompt|developer message)\b/i],
  ['tool-directive', /\b(call|invoke|use) (the )?(tool|function)\b|\b(refund|transfer|pay out|charge)\b[^.\n]{0,30}\b(immediately|now|to my account)\b/i],
];

export type InjectionFlag = { source: 'code'; location: string; author: string; pattern: string; excerpt: string; note: 'instruction-like text in evidence, ignored' };

export function scanText(location: string, author: string, text: string | null | undefined): InjectionFlag[] {
  if (!text) return [];
  const hits = PATTERNS.map(([name, re]) => ({ name, m: text.match(re) })).filter((h) => h.m && h.m.index !== undefined);
  if (!hits.length) return [];
  // One flag per text, naming every pattern that matched; excerpt around the first match.
  const first = hits.reduce((a, b) => (b.m!.index! < a.m!.index! ? b : a));
  const start = Math.max(0, first.m!.index! - 20);
  return [{ source: 'code', location, author, pattern: hits.map((h) => h.name).join(', '), excerpt: text.slice(start, first.m!.index! + first.m![0].length + 40).trim(), note: 'instruction-like text in evidence, ignored' }];
}

export function looksLikeInstruction(text: string): boolean {
  return PATTERNS.some(([, re]) => re.test(text));
}
