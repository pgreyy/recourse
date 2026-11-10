// Probe 3b (fallback when vaulting is unavailable): a normal buyer-approved checkout, nothing saved.
// Same custom_id (64-char sha256 hex) and invoice_id as probe 3, so the round trip is still tested,
// and the capture feeds probes 4 (dispute) and 7 (refund).
// Usage: npx tsx scripts/probes/03b-order-buyer-present.ts            create, print the approve link
//        npx tsx scripts/probes/03b-order-buyer-present.ts --capture  capture, GET, check custom_id
import { createHash } from 'node:crypto';
import {
  CheckoutPaymentIntent,
  PaypalExperienceUserAction,
  PaypalWalletContextShippingPreference,
} from '@paypal/paypal-server-sdk';
import { currency, env, flag, requireValue, saveValues } from '../lib/env';
import { requestId } from '../lib/http';
import { showLinks } from '../lib/print';
import { orders, sdkCall } from '../lib/sdk';

if (!flag('capture')) {
  const amount = env('ORDER_AMOUNT', '25.00')!;
  const mandate = {
    kind: 'recourse.test-mandate',
    created: new Date().toISOString(),
    amount: { currency_code: currency(), value: amount },
    description: 'Recourse probe 3b: agent checkout, buyer present',
  };
  const customId = createHash('sha256').update(JSON.stringify(mandate)).digest('hex');
  const invoiceRef = `RCS-TEST-${Date.now()}`;
  console.log('custom_id preimage:', JSON.stringify(mandate));
  console.log(`custom_id (sha256, ${customId.length} chars): ${customId}`);
  console.log(`invoice_id: ${invoiceRef}`);
  const port = env('PORT', '8787');

  const res = await sdkCall('POST /v2/checkout/orders (buyer present, no vault)', () =>
    orders.createOrder({
      paypalRequestId: requestId(),
      prefer: 'return=representation',
      body: {
        intent: CheckoutPaymentIntent.Capture,
        purchaseUnits: [
          {
            referenceId: 'default',
            description: mandate.description,
            customId,
            invoiceId: invoiceRef,
            amount: { currencyCode: currency(), value: amount },
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
          },
        },
      },
    }),
  );
  if (res.status >= 300) process.exit(1);
  console.log('\nLinks:');
  showLinks(res.body.links);
  saveValues({ ORDER_ID: res.body.id, CUSTOM_ID: customId, INVOICE_REF: invoiceRef });
  const approve = res.body.links?.find((l: { rel: string }) => l.rel === 'payer-action' || l.rel === 'approve')?.href;
  console.log(`\nOpen and pay as the buyer sandbox account:\n  ${approve}`);
  console.log('Then run: npx tsx scripts/probes/03b-order-buyer-present.ts --capture');
} else {
  const orderId = requireValue('ORDER_ID', 'Run 03b-order-buyer-present.ts first.');
  const customId = requireValue('CUSTOM_ID', 'Run 03b-order-buyer-present.ts first.');
  const captured = await sdkCall(`POST /v2/checkout/orders/${orderId}/capture`, () =>
    orders.captureOrder({ id: orderId, paypalRequestId: requestId(), prefer: 'return=representation' }),
  );
  if (captured.status >= 300) process.exit(1);

  const fetched = await sdkCall(`GET /v2/checkout/orders/${orderId}`, () => orders.getOrder({ id: orderId }));
  const unit = fetched.body.purchase_units?.[0];
  const capture = unit?.payments?.captures?.[0] ?? captured.body.purchase_units?.[0]?.payments?.captures?.[0];

  console.log('\n--- custom_id check');
  console.log(`sent:                       ${customId}`);
  console.log(`GET order purchase_unit:    ${unit?.custom_id ?? '(missing)'}`);
  console.log(`GET order capture:          ${capture?.custom_id ?? '(missing)'}`);
  console.log(`invoice_id on capture:      ${capture?.invoice_id ?? '(missing)'}`);
  console.log(unit?.custom_id === customId ? 'RESULT: custom_id returned intact' : 'RESULT: custom_id NOT returned intact');
  saveValues({ CAPTURE_ID: capture?.id, CAPTURE_AMOUNT: capture?.amount?.value });
}
