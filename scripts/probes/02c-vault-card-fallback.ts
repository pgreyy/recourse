// Probe 2c (fallback): vault a sandbox test card when PayPal wallet vaulting returns
// NOT_ENABLED_TO_VAULT_PAYMENT_SOURCE. Card setup tokens need no browser approval unless 3DS is triggered.
// Usage: npx tsx scripts/probes/02c-vault-card-fallback.ts [--operator]
import { VaultCardVerificationMethod, VaultTokenRequestType } from '@paypal/paypal-server-sdk';
import { env, saveValues } from '../lib/env';
import { requestId } from '../lib/http';
import { showLinks } from '../lib/print';
import { sdkCall, vault } from '../lib/sdk';
import { role } from '../lib/vault';

const who = role();
const setup = await sdkCall('POST /v3/vault/setup-tokens (card)', () =>
  vault.createSetupToken({
    paypalRequestId: requestId(),
    body: {
      paymentSource: {
        card: {
          name: 'Sandbox Tester',
          number: env('TEST_CARD_NUMBER', '4111111111111111'),
          expiry: env('TEST_CARD_EXPIRY', '2030-12'),
          securityCode: '123',
          verificationMethod: VaultCardVerificationMethod.ScaWhenRequired,
          billingAddress: {
            addressLine1: '1 Main St',
            adminArea2: 'San Jose',
            adminArea1: 'CA',
            postalCode: '95131',
            countryCode: 'US',
          },
        },
      },
    },
  }),
);
if (setup.status >= 300) process.exit(1);
console.log('\nLinks:');
showLinks(setup.body.links);
if (setup.body.status !== 'APPROVED') {
  console.log(`\nSetup token status is ${setup.body.status}; open the approve link above (3DS) and rerun 02b with id ${setup.body.id}.`);
  saveValues({ [`${who}_SETUP_TOKEN_ID`]: setup.body.id });
  process.exit(0);
}

const token = await sdkCall('POST /v3/vault/payment-tokens (from card setup token)', () =>
  vault.createPaymentToken({
    paypalRequestId: requestId(),
    body: { paymentSource: { token: { id: setup.body.id, type: VaultTokenRequestType.SetupToken } } },
  }),
);
if (token.status >= 300) process.exit(1);
saveValues({ [`${who}_CARD_VAULT_ID`]: token.body.id, [`${who}_CUSTOMER_ID`]: token.body.customer?.id });
console.log(`\nvault_id: ${token.body.id}`);
console.log(`Charge it with: npx tsx scripts/probes/${who === 'OPERATOR' ? '08-operator-charge.ts --card' : '03-order-vault-capture.ts --card'}`);
