import { fixPlural, instructionWords } from '../shared/words';
import { isKnownVariant, itemWords, verdictWords } from './timeline';

/** Clause ids as words ("attribute.size" is "the size clause"). */
const CLAUSE: Record<string, string> = {
  'attribute.size.gender': 'gender',
  'attribute.size': 'size',
  'brand.allowlist': 'brand',
  'merchant.allowlist': 'merchant',
  'budget.aggregate': 'budget',
  'quantity.max': 'quantity',
  'orders.max': 'number of orders',
  substitution: 'substitution',
  deadline: 'deadline',
  'stay.refund_policy': 'refund policy',
  'stay.city': 'city',
  'stay.dates': 'dates',
  'stay.nights': 'nights',
  'stay.stars': 'stars',
};

/** Field names the model sometimes repeats from the evidence pack, as words. */
const FIELD: Array<[RegExp, string]> = [
  [/\b(?:the\s+)?code_facts\b/gi, 'the code checks'],
  [/\b(?:the\s+)?decision_facts\b/gi, 'the recorded decision facts'],
  [/\b(?:the\s+)?compliant_alternatives\b/gi, 'the compliant alternatives'],
  [/\bcited_entries\b/gi, 'cited steps'],
  [/\bcode_status\b/gi, 'code result'],
  [/\bagent_fault_definition\b/gi, 'agent-fault definition'],
  [/\bmandate\.clauses\b/gi, "the clauses of the instructions"],
  [/\b(?:unit_system|size_system)\s*(?:=|:|is)?\s*null\b/gi, 'no size system'],
  [/\b(?:unit_system|size_system)\b/gi, 'size system'],
  [/\b(?:refund_policy)\s*(?:=|:|is)\s*null\b/gi, 'refund policy was not provided'],
  // Programming words: "is null" becomes "was not provided"; a lone null or undefined becomes "not provided".
  [/\b(?:is|was|are|were)\s+(?:null|undefined)\b/gi, 'was not provided'],
  [/\s*(?:=|:)\s*(?:null|undefined)\b/gi, ' was not provided'],
  [/\b(?:null|undefined)\b/gi, 'not provided'],
];

const STATUS: Record<string, string> = { UNVERIFIABLE: 'unverifiable', VIOLATION: 'a violation', WARN: 'warning', WARNING: 'warning', PASS: 'pass', CAPTURED: 'captured', READY: 'ready', INCOMPLETE: 'incomplete' };

function stepList(nums: string[]): string {
  if (nums.length === 1) return `step ${nums[0]}`;
  return `steps ${nums.slice(0, -1).join(', ')} and ${nums[nums.length - 1]}`;
}

/**
 * The model's reasoning in plain English for the screens: recorder seqs become "step N", field and clause names
 * become words, variant ids become product names. Only what is shown changes; the stored model output stays as it was.
 */
export function plainText(text: string | null | undefined): string | null {
  if (!text) return text ?? null;
  let s = fixPlural(text.trim());
  // seq 8-9, seqs 8 and 9, (seq 12), seq=12, entries 3, 5 and 6
  s = s.replace(/\b(?:seqs?|entr(?:y|ies)|steps?)\s*[=:]?\s*(\d+)\s*[–-]\s*(\d+)/gi, 'steps $1 to $2');
  s = s.replace(/\b(?:seqs?|entr(?:y|ies)|steps?)\s*[=:]?\s*\[?(\d+(?:\s*(?:,|and|&)\s*\d+)*)(?!\d)\]?(?!\s*(?:to|[–-])\s*\d)/gi, (_m, list: string) => stepList(list.split(/\s*(?:,|and|&)\s*/)));
  s = s.replace(/\b(no|without|lacked|lacks|lacking)\s+(?:a\s+)?(?:unit_system|size_system)\b/gi, (_m, w: string) => (w.toLowerCase() === 'no' ? `${w} size system` : `${w} a size system`));
  for (const [re, words] of FIELD) s = s.replace(re, words);
  // Clause ids, longest first.
  for (const [id, word] of Object.entries(CLAUSE).sort((a, b) => b[0].length - a[0].length)) {
    const esc = id.replace(/\./g, '\\.');
    s = s.replace(new RegExp(`\\b(?:(?:the|a|an)\\s+)?(?:signed\\s+)?(?:mandate\\s+)?clause\\s+(?:for\\s+)?\\(?${esc}\\)?`, 'gi'), `the ${word} clause`);
    s = s.replace(new RegExp(`\\(${esc}\\)`, 'g'), `(the ${word} clause)`);
    if (id.includes('.')) s = s.replace(new RegExp(`\\b${esc}\\b`, 'g'), `the ${word} clause`);
  }
  // Verdict and status codes.
  s = s.replace(/\b(AGENT_FAULT|MERCHANT_FAULT|BUYER_REMORSE|THIRD_PARTY_FAULT|INCONCLUSIVE)\b/g, (v) => verdictWords(v));
  s = s.replace(/\b(UNVERIFIABLE|VIOLATION|WARNING|WARN|PASS|CAPTURED|READY|INCOMPLETE)\b/g, (v) => STATUS[v] ?? v.toLowerCase());
  // Variant ids (lowercase words joined by hyphens, ending in a size).
  s = s.replace(/\b[a-z]+(?:-[a-z0-9]+)+\b/g, (id) => (isKnownVariant(id) ? itemWords(id) : id));
  // Anything else written like a field name: underscores to spaces.
  s = s.replace(/\b([a-z]+)_([a-z_]+)\b/g, (m) => m.replace(/_/g, ' '));
  s = s.replace(/\bAND\b/g, 'and');
  s = instructionWords(s);
  // A sentence that now starts in lower case.
  s = s.replace(/(^|[.!?]\s+)([a-z])/g, (_m, a: string, b: string) => a + b.toUpperCase());
  return s.replace(/\s{2,}/g, ' ');
}

export const plainList = (xs: string[] | null | undefined) => (xs ?? []).map((x) => plainText(x) ?? '');
