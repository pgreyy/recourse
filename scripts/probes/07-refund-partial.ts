// Probe 7: refund part of a capture directly (POST /v2/payments/captures/{id}/refund) and print the result.
// Usage: npx tsx scripts/probes/07-refund-partial.ts [captureId] [amount]   (default 5.00)
import { args, currency, requireValue, saveValues } from '../lib/env';
import { requestId } from '../lib/http';
import { payments, sdkCall } from '../lib/sdk';

const captureId = args()[0] ?? requireValue('CAPTURE_ID', 'Run 03-order-vault-capture.ts first.');
const amount = args()[1] ?? '5.00';

const res = await sdkCall(`POST /v2/payments/captures/${captureId}/refund (${amount} ${currency()})`, () =>
  payments.refundCapturedPayment({
    captureId,
    paypalRequestId: requestId(),
    prefer: 'return=representation',
    body: {
      amount: { currencyCode: currency(), value: amount },
      noteToPayer: 'Recourse probe 7: partial refund.',
    },
  }),
);
if (res.status >= 300) process.exit(1);
saveValues({ REFUND_ID: res.body.id });

await sdkCall(`GET /v2/payments/captures/${captureId} (after refund)`, () => payments.getCapturedPayment({ captureId }));
