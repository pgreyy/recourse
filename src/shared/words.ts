/** Older stored text says "1 listing(s)": shown as "1 listing", "2 listings". */
export function fixPlural(text: string): string {
  return text.replace(/\b(\d+) ([A-Za-z-]+(?: [A-Za-z-]+)?)\(s\)/g, (_m, n: string, w: string) => `${n} ${w}${n === '1' ? '' : 's'}`);
}

/** "1 case", "2 cases". */
export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}
