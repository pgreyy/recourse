import {
  ExperienceContextShippingPreference,
  VaultUserAction,
  PaypalPaymentTokenCustomerType,
  PaypalPaymentTokenUsageType,
  UsagePattern,
  VaultTokenRequestType,
} from '@paypal/paypal-server-sdk';
import { args, env, flag, requireValue, saveValues } from './env';
import { requestId } from './http';
import { showLinks } from './print';
import { sdkCall, vault } from './sdk';

export type Role = 'BUYER' | 'OPERATOR';

/** Probes 2 and 8 share these. `--operator` stores under OPERATOR_*, otherwise BUYER_*. */
export function role(): Role {
  return flag('operator') ? 'OPERATOR' : 'BUYER';
}

const opFlag = (who: Role) => (who === 'OPERATOR' ? ' --operator' : '');

export async function createPaypalSetupToken(who: Role): Promise<void> {
  const port = env('PORT', '8787');
  const usage = env('VAULT_USAGE_PATTERN', 'IMMEDIATE') as UsagePattern;
  const res = await sdkCall(`POST /v3/vault/setup-tokens (paypal, ${who.toLowerCase()})`, () =>
    vault.createSetupToken({
      paypalRequestId: requestId(),
      body: {
        paymentSource: {
          paypal: {
            description:
              who === 'OPERATOR'
                ? 'Recourse: agent operator pre-authorized liability payments'
                : 'Recourse: buyer saved PayPal for agent checkout',
            usagePattern: usage,
            usageType: PaypalPaymentTokenUsageType.Merchant,
            customerType: PaypalPaymentTokenCustomerType.Consumer,
            permitMultiplePaymentTokens: false,
            experienceContext: {
              brandName: 'Recourse',
              locale: 'en-US',
              shippingPreference: ExperienceContextShippingPreference.NoShipping,
              userAction: VaultUserAction.Continue,
              returnUrl: env('RETURN_URL', `http://localhost:${port}/return`),
              cancelUrl: env('CANCEL_URL', `http://localhost:${port}/cancel`),
            },
          },
        },
      },
    }),
  );
  if (res.status >= 300) {
    if (JSON.stringify(res.body).includes('NOT_ENABLED_TO_VAULT_PAYMENT_SOURCE')) {
      console.log('\nNOT_ENABLED_TO_VAULT_PAYMENT_SOURCE: vaulting PayPal wallets is not enabled for this app.');
      console.log('Fallback: npx tsx scripts/probes/02c-vault-card-fallback.ts');
    }
    process.exit(1);
  }
  console.log('\nLinks:');
  showLinks(res.body.links);
  const approve = res.body.links?.find((l: { rel: string }) => l.rel === 'approve')?.href;
  saveValues({ [`${who}_SETUP_TOKEN_ID`]: res.body.id });
  console.log(`\nOpen this link and log in as the ${who.toLowerCase()} sandbox personal account:\n  ${approve}`);
  console.log(`Then run: npx tsx scripts/probes/02b-vault-payment-token.ts${opFlag(who)}`);
}

export async function exchangeSetupToken(who: Role): Promise<void> {
  const setupTokenId =
    args()[0] ?? requireValue(`${who}_SETUP_TOKEN_ID`, `Run 02a-vault-setup-token.ts${opFlag(who)} first.`);

  await sdkCall(`GET /v3/vault/setup-tokens/${setupTokenId}`, () => vault.getSetupToken(setupTokenId));

  const res = await sdkCall('POST /v3/vault/payment-tokens', () =>
    vault.createPaymentToken({
      paypalRequestId: requestId(),
      body: { paymentSource: { token: { id: setupTokenId, type: VaultTokenRequestType.SetupToken } } },
    }),
  );
  if (res.status >= 300) process.exit(1);

  const vaultId: string = res.body.id;
  saveValues({ [`${who}_VAULT_ID`]: vaultId, [`${who}_CUSTOMER_ID`]: res.body.customer?.id });
  console.log(`\nvault_id: ${vaultId}`);
  console.log(
    who === 'OPERATOR'
      ? `To pin it, add to .env: OPERATOR_VAULT_ID=${vaultId}\nNext: npx tsx scripts/probes/08-operator-charge.ts`
      : 'Next: npx tsx scripts/probes/03-order-vault-capture.ts',
  );
}
