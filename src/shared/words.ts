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
  [/\brulings\b/g, 'decisions'],
  [/\bRulings\b/g, 'Decisions'],
  [/\bruling\b/g, 'decision'],
  [/\bRuling\b/g, 'Decision'],
];
export function instructionWords(text: string): string {
  let s = text;
  for (const [re, w] of WORDS) s = s.replace(re, w);
  return s;
}
