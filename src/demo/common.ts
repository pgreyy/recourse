import { env } from '../config';

/** The recorded runs kept in demo_archive: label -> case_ref. */
export const SCENARIOS: Record<string, string> = {
  A: 'CASE-20261110-175E2257', // agent fault, recovered from the operator
  B: 'CASE-20261110-332A0406', // live PayPal dispute, buyer's remorse, evidence filed
};

/** Tables in foreign-key order (parents first). Restore inserts in this order; nothing here is deleted by restore. */
export const ARCHIVE_TABLES = [
  'buyers',
  'payment_tokens',
  'liability_agreements',
  'liability_agreement_agent_versions',
  'mandates',
  'catalog_snapshots',
  'carts',
  'agent_runs',
  'orders',
  'step_ups',
  'receipts',
  'cases',
  'case_statements',
  'assessments',
  'rulings',
  'appeals',
  'settlement_obligations',
  'settlement_actions',
  'reputation_events',
  'recorder_entries',
  'recorder_checkpoints',
  'paypal_events',
] as const;

/** The retail demo's own rows (operator, agents, saved PayPal, agreements), archived as RETAIL; parents first. */
export const RETAIL_TABLES = ['operators', 'agents', 'agent_versions', 'liability_agreements', 'liability_agreement_agent_versions', 'payment_tokens'] as const;

/** Refuse to touch a Neon database unless the owner passed --neon on purpose. */
export function guardDatabase(argv: string[]) {
  const url = env('DATABASE_URL') ?? '';
  let host = '(unset)';
  try {
    host = new URL(url).hostname;
  } catch {
    /* not a URL */
  }
  const isNeon = /neon\.tech$/i.test(host);
  if (isNeon && !argv.includes('--neon')) {
    console.error(`Refusing: DATABASE_URL points at Neon (${host.replace(/^[^.]+/, '…')}). Add --neon to run against it on purpose.`);
    process.exit(2);
  }
  return { host: isNeon ? `Neon (${host.replace(/^[^.]+/, '…')})` : host };
}
