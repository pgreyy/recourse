// Probe 8: operator pre-authorized liability.
// Step 1 (once): vault the operator's PayPal by rerunning probe 2 approved as the operator sandbox account:
//   npx tsx scripts/probes/02a-vault-setup-token.ts --operator   (log in as the operator)
//   npx tsx scripts/probes/02b-vault-payment-token.ts --operator  (saves OPERATOR_VAULT_ID)
// Step 2 (this script): charge OPERATOR_VAULT_ID with a payer-not-present order (probe 3 shape) and capture.
// Usage: npx tsx scripts/probes/08-operator-charge.ts [vaultId] [--card]
import { chargeVault } from '../lib/charge';
import { args, env, flag, requireValue } from '../lib/env';

const card = flag('card');
const vaultId =
  args()[0] ??
  (card
    ? requireValue('OPERATOR_CARD_VAULT_ID', 'Run 02c-vault-card-fallback.ts --operator first.')
    : requireValue('OPERATOR_VAULT_ID', 'Run 02a and 02b with --operator first.'));

await chargeVault({
  vaultId,
  source: card ? 'card' : 'paypal',
  amount: env('OPERATOR_CHARGE_AMOUNT', '25.00')!,
  description: 'Recourse probe 8: agent operator liability charge, payer not present',
  savePrefix: 'OPERATOR_',
});
