// Probe 3: create and capture an order with payment_source.paypal.vault_id (payer not present),
// custom_id = 64-char sha256 hex, invoice_id = test ref. Then GET the order and confirm custom_id.
// Usage: npx tsx scripts/probes/03-order-vault-capture.ts [vaultId] [--card]
import { chargeVault } from '../lib/charge';
import { args, env, flag, requireValue } from '../lib/env';

const card = flag('card');
const vaultId =
  args()[0] ??
  (card
    ? requireValue('BUYER_CARD_VAULT_ID', 'Run 02c-vault-card-fallback.ts first.')
    : requireValue('BUYER_VAULT_ID', 'Run 02a and 02b first.'));

await chargeVault({
  vaultId,
  source: card ? 'card' : 'paypal',
  amount: env('ORDER_AMOUNT', '25.00')!,
  description: 'Recourse probe 3: agent checkout, payer not present',
  savePrefix: '',
});
