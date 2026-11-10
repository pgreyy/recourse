/**
 * Fixed size table for men's running shoes: US / UK / EU. Code, never the LLM, converts sizes; the
 * Phase 3 firewall uses this to compare a listing against a mandate. Values follow a common men's
 * running-shoe chart (US = UK + 1). Brands differ by up to half a size, so equivalence is exact
 * table lookup only: anything not in the table is "unknown", never guessed.
 */
export type UnitSystem = 'US' | 'UK' | 'EU';

export const MENS_RUNNING_SIZES: ReadonlyArray<Readonly<Record<UnitSystem, string>>> = [
  { US: '7', UK: '6', EU: '40' },
  { US: '7.5', UK: '6.5', EU: '40.5' },
  { US: '8', UK: '7', EU: '41' },
  { US: '8.5', UK: '7.5', EU: '42' },
  { US: '9', UK: '8', EU: '42.5' },
  { US: '9.5', UK: '8.5', EU: '43' },
  { US: '10', UK: '9', EU: '44' },
  { US: '10.5', UK: '9.5', EU: '44.5' },
  { US: '11', UK: '10', EU: '45' },
  { US: '11.5', UK: '10.5', EU: '45.5' },
  { US: '12', UK: '11', EU: '46' },
  { US: '12.5', UK: '11.5', EU: '47' },
  { US: '13', UK: '12', EU: '47.5' },
  { US: '14', UK: '13', EU: '48.5' },
];

const norm = (s: string) => String(Number(s.trim()));

/** Convert a men's size between systems. Returns null when the size is not in the table. */
export function convertMensSize(size: string, from: UnitSystem, to: UnitSystem): string | null {
  if (from === to) return norm(size);
  const row = MENS_RUNNING_SIZES.find((r) => norm(r[from]) === norm(size));
  return row ? row[to] : null;
}

/**
 * Do two sizes denote the same men's shoe size? 'unknown' when either side has no unit system or the
 * size is not in the table: a bare "10" could be US 10 or UK 10 (which is US 11).
 */
export function sameMensSize(
  a: { size: string; unit_system: string | null },
  b: { size: string; unit_system: string | null },
): true | false | 'unknown' {
  if (!a.unit_system || !b.unit_system) return 'unknown';
  const converted = convertMensSize(a.size, a.unit_system as UnitSystem, b.unit_system as UnitSystem);
  if (converted === null) return 'unknown';
  return norm(converted) === norm(b.size);
}
