// Probe 2d (fallback for 2a/2b): save PayPal during a purchase instead of with a setup token.
// Creates an order with payment_source.paypal.attributes.vault.store_in_vault = ON_SUCCESS and prints the
// payer-action link. After approval, `--capture` captures it and reads the vault id from the capture response.
// Usage: npx tsx scripts/probes/02d-vault-with-purchase.ts [--operator]
//        npx tsx scripts/probes/02d-vault-with-purchase.ts --capture [orderId] [--operator]
import {
  CheckoutPaymentIntent,
  PaypalExperienceUserAction,
  PaypalPaymentTokenCustomerType,
  PaypalPaymentTokenUsageType,
  PaypalWalletContextShippingPreference,
  StoreInVaultInstruction,
  UsagePattern,
} from '@paypal/paypal-server-sdk';
import { args, currency, env, flag, requireValue, saveValues } from '../lib/env';
import { requestId } from '../lib/http';
import { showLinks } from '../lib/print';
import { orders, sdkCall } from '../lib/sdk';
import { role } from '../lib/vault';

const who = role();
const op = who === 'OPERATOR' ? ' --operator' : '';

if (!flag('capture')) {
  const port = env('PORT', '8787');
  const res = await sdkCall(`POST /v2/checkout/orders (paypal, store_in_vault ON_SUCCESS, ${who.toLowerCase()})`, () =>
    orders.createOrder({
      paypalRequestId: requestId(),
      prefer: 'return=representation',
      body: {
        intent: CheckoutPaymentIntent.Capture,
        purchaseUnits: [
          {
            referenceId: 'default',
            description: 'Recourse probe 2d: first purchase that also saves PayPal',
            amount: { currencyCode: currency(), value: env('ORDER_AMOUNT', '10.00')! },
          },
        ],
        paymentSource: {
          paypal: {
            experienceContext: {
              brandName: 'Recourse',
              locale: 'en-US',
              shippingPreference: PaypalWalletContextShippingPreference.NoShipping,
              userAction: PaypalExperienceUserAction.PayNow,
              returnUrl: env('RETURN_URL', `http://localhost:${port}/return`),
              cancelUrl: env('CANCEL_URL', `http://localhost:${port}/cancel`),
            },
            attributes: {
              vault: {
                storeInVault: StoreInVaultInstruction.OnSuccess,
                usageType: PaypalPaymentTokenUsageType.Merchant,
                customerType: PaypalPaymentTokenCustomerType.Consumer,
                usagePattern: env('VAULT_USAGE_PATTERN', 'IMMEDIATE') as UsagePattern,
                permitMultiplePaymentTokens: false,
              },
            },
          },
        },
      },
    }),
  );
  if (res.status >= 300) process.exit(1);
  console.log('\nLinks:');
  showLinks(res.body.links);
  const approve = res.body.links?.find((l: { rel: string }) => l.rel === 'payer-action' || l.rel === 'approve')?.href;
  saveValues({ [`${who}_VAULT_ORDER_ID`]: res.body.id });
  console.log(`\nOpen and approve as the ${who.toLowerCase()} sandbox account:\n  ${approve}`);
  console.log(`Then run: npx tsx scripts/probes/02d-vault-with-purchase.ts --capture${op}`);
} else {
  const orderId = args()[0] ?? requireValue(`${who}_VAULT_ORDER_ID`, `Run 02d-vault-with-purchase.ts${op} first.`);
  const res = await sdkCall(`POST /v2/checkout/orders/${orderId}/capture`, () =>
    orders.captureOrder({ id: orderId, paypalRequestId: requestId(), prefer: 'return=representation' }),
  );
  if (res.status >= 300) process.exit(1);
  const vault = res.body.payment_source?.paypal?.attributes?.vault;
  console.log(`\nvault.status: ${vault?.status ?? '(none)'}   vault.id: ${vault?.id ?? '(none)'}`);
  saveValues({ [`${who}_VAULT_ID`]: vault?.id, [`${who}_CUSTOMER_ID`]: vault?.customer?.id });
}
