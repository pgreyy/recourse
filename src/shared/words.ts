/** Older stored text says "1 listing(s)": shown as "1 listing", "2 listings". */
export function fixPlural(text: string): string {
  return text.replace(/\b(\d+) ([A-Za-z-]+(?: [A-Za-z-]+)?)\(s\)/g, (_m, n: string, w: string) => `${n} ${w}${n === '1' ? '' : 's'}`);
}

/** "1 case", "2 cases". */
export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/**
 * User-facing wording for text that code wrote earlier (firewall details, code checks, stored notes):
 * "mandate" becomes "instructions" and "ruling" becomes "decision". Identifiers, routes and stored data
 * keep their names; quotes from buyers, merchants and agents are not passed through this.
 */
const WORDS: Array<[RegExp, string]> = [
  [/\bthe mandate_hash\b/g, 'the instructions hash'],
  [/\bmandate_hash\b/g, 'instructions hash'],
  [/\b(the )?mandate requires\b/g, 'the instructions require'],
  [/\b(the )?mandate does\b/g, 'the instructions do'],
  [/\b(the )?mandate is\b/g, 'the instructions are'],
  [/\b(the )?mandate asked\b/g, 'the instructions asked'],
  [/\bmandate hash\b/gi, 'hash'],
  [/\b(every|each|one|a|any) (signed )?mandate clause\b/g, '$1 clause of the instructions'],
  [/\bmandate clauses\b/g, 'clauses of the instructions'],
  [/\bmandate clause\b/g, 'clause of the instructions'],
  [/\bmandate rule\b/g, 'rule in the instructions'],
  [/\bmandate's\b/g, "instructions'"],
  [/\ba (signed )?mandate\b/g, '$1instructions'],
  [/\bmandates\b/g, 'instructions'],
  [/\bMandates\b/g, 'Instructions'],
  [/\bmandate\b/g, 'instructions'],
  [/\bMandate\b/g, 'Instructions'],
  [/\bRULING_APPROVED\b/g, 'DECISION_APPROVED'],
  [/\bRULED\b/g, 'DECISION APPROVED'],
  [/\bverdicts\b/g, 'findings'],
  [/\bVerdicts\b/g, 'Findings'],
  [/\bverdict\b/g, 'finding'],
  [/\bVerdict\b/g, 'Finding'],
  [/\brulings\b/g, 'decisions'],
  [/\bRulings\b/g, 'Decisions'],
  [/\bruling\b/g, 'decision'],
  [/\bRuling\b/g, 'Decision'],
];
/** Amounts in one format everywhere: "1,000.00". Anything that is not a number is returned as it is. */
export function amountText(v: string | number | null | undefined): string {
  const n = Number(v);
  if (v === null || v === undefined || v === '' || !Number.isFinite(n)) return String(v ?? '');
  return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** "11 Nov 2026, 00:59 UTC" for an ISO timestamp. */
export function dateWords(iso: string): string {
  const t = new Date(iso);
  if (Number.isNaN(t.getTime())) return iso;
  return `${t.getUTCDate()} ${t.toLocaleString('en-GB', { month: 'short', timeZone: 'UTC' })} ${t.getUTCFullYear()}, ${t.toISOString().slice(11, 16)} UTC`;
}

const ACTION_WORDS: Record<string, string> = {
  REFUND_BUYER: 'buyer refund',
  CHARGE_OPERATOR: 'operator charge',
  INVOICE_OPERATOR: 'operator invoice',
  REFUND_OPERATOR: 'refund to the operator',
  DISPUTE_ESCALATE: 'dispute escalated',
  DISPUTE_PROVIDE_EVIDENCE: 'evidence sent to PayPal',
  DISPUTE_ACCEPT_CLAIM: 'dispute claim accepted',
  DISPUTE_MAKE_OFFER: 'dispute offer made',
};
const CODE_WORDS: Record<string, string> = {
  AGENT_FAULT: 'agent fault',
  MERCHANT_FAULT: 'merchant fault',
  BUYER_REMORSE: "buyer's remorse",
  THIRD_PARTY_FAULT: 'third-party fault',
  INCONCLUSIVE: 'inconclusive',
  RECOVERED: 'recovered',
  AWAITING_CONFIRMATION: 'awaiting confirmation',
  AWAITING_PAYPAL: 'awaiting PayPal',
  BUYER_REFUNDED: 'buyer refunded',
  COMPLETED: 'completed',
  NO_ACTION: 'no action',
  INVOICED: 'invoiced',
  DECISION_APPROVED: 'decision approved',
  RULING_APPROVED: 'decision approved',
  NEEDS_HUMAN_REVIEW: 'needs human review',
};

/**
 * Text for people from text that may carry internal codes (REFUND_BUYER SUCCEEDED, AGENT_FAULT) or raw timestamps:
 * codes become plain words and timestamps read "11 Nov 2026, 00:59 UTC". PayPal ids are left as they are.
 */
export function plainCodes(text: string): string {
  let s = text.replace(/\b(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?Z)\b/g, (m) => dateWords(m));
  s = s.replace(/\b(REFUND_BUYER|CHARGE_OPERATOR|INVOICE_OPERATOR|REFUND_OPERATOR|DISPUTE_[A-Z_]+)\s+(SUCCEEDED|FAILED|INTENDED|UNCERTAIN)\b/g, (_m, a: string, st: string) =>
    `${ACTION_WORDS[a] ?? a.toLowerCase().replace(/_/g, ' ')} ${st === 'SUCCEEDED' ? 'succeeded' : st === 'FAILED' ? 'failed' : 'in progress'}`,
  );
  s = s.replace(/\b(REFUND_BUYER|CHARGE_OPERATOR|INVOICE_OPERATOR|REFUND_OPERATOR|DISPUTE_[A-Z_]+)\b/g, (a) => ACTION_WORDS[a] ?? a.toLowerCase().replace(/_/g, ' '));
  s = s.replace(/\b[A-Z]+(?:_[A-Z]+)+\b|\b(RECOVERED|INCONCLUSIVE|COMPLETED|INVOICED)\b/g, (c) => CODE_WORDS[c] ?? c);
  return s;
}

export function instructionWords(text: string): string {
  let s = text;
  for (const [re, w] of WORDS) s = s.replace(re, w);
  return s;
}
