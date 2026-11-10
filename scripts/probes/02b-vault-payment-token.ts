// Probe 2b: turn the approved setup token into a payment token and print vault_id.
// Usage: npx tsx scripts/probes/02b-vault-payment-token.ts [setupTokenId] [--operator]
import { exchangeSetupToken, role } from '../lib/vault';

await exchangeSetupToken(role());
