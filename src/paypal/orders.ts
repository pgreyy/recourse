import { CheckoutPaymentIntent, type PaymentSource } from '@paypal/paypal-server-sdk';
import { requestId } from './http';
import { callSdk, sdk } from './sdk';
import type { PPResponse } from './types';

export type VaultOrderInput = {
  vaultId: string;
  source: 'paypal' | 'card';
  amount: string;
  currency: string;
  /** Up to 127 chars; Recourse uses the 64-char mandate_hash. Returned on the order and the capture. */
  customId: string;
  /** Unique per merchant; returned on the capture and on refunds. */
  invoiceId: string;
  description: string;
};

/**
 * POST /v2/checkout/orders with a vault_id, payer not present. In Phase 0 this came back
 * COMPLETED (captured) in the same call, so callers should check status before capturing.
 */
export function createVaultOrder(input: VaultOrderInput): Promise<PPResponse> {
  const paymentSource: PaymentSource =
    input.source === 'card' ? { card: { vaultId: input.vaultId } } : { paypal: { vaultId: input.vaultId } };
  return callSdk('POST /v2/checkout/orders', () =>
    sdk().orders.createOrder({
      paypalRequestId: requestId(),
      prefer: 'return=representation',
      body: {
        intent: CheckoutPaymentIntent.Capture,
        purchaseUnits: [
          {
            referenceId: 'default',
            description: input.description,
            customId: input.customId,
            invoiceId: input.invoiceId,
            amount: { currencyCode: input.currency, value: input.amount },
          },
        ],
        paymentSource,
      },
    }),
  );
}

export function captureOrder(id: string): Promise<PPResponse> {
  return callSdk(`POST /v2/checkout/orders/${id}/capture`, () =>
    sdk().orders.captureOrder({ id, paypalRequestId: requestId(), prefer: 'return=representation' }),
  );
}

export function getOrder(id: string): Promise<PPResponse> {
  return callSdk(`GET /v2/checkout/orders/${id}`, () => sdk().orders.getOrder({ id }));
}

/** First capture of the first purchase unit, from an order body. */
export function firstCapture(order: any): any | undefined {
  return order?.purchase_units?.[0]?.payments?.captures?.[0];
}
