// Probe 2a: create a PayPal setup token (Vault v3) and print the approve link.
// Add --operator to approve as the agent operator sandbox account (probe 8).
import { createPaypalSetupTokenProbe as createPaypalSetupToken, role } from '../lib/vault';

await createPaypalSetupToken(role());
