import {
  CheckoutPaymentIntent,
  PaypalExperienceUserAction,
  PaypalWalletContextShippingPreference,
  ShipmentCarrier,
  type PaymentSource,
} from '@paypal/paypal-server-sdk';
import { requestId as newRequestId } from './http';
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
export function createVaultOrder(input: VaultOrderInput, requestId?: string): Promise<PPResponse> {
  const paymentSource: PaymentSource =
    input.source === 'card' ? { card: { vaultId: input.vaultId } } : { paypal: { vaultId: input.vaultId } };
  // Same PayPal-Request-Id => PayPal returns the original order instead of creating (and charging) again.
  const rid = requestId ?? newRequestId();
  return callSdk('POST /v2/checkout/orders', () =>
    sdk().orders.createOrder({
      paypalRequestId: rid,
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

export function captureOrder(id: string, requestId?: string): Promise<PPResponse> {
  return callSdk(`POST /v2/checkout/orders/${id}/capture`, () =>
    sdk().orders.captureOrder({ id, paypalRequestId: requestId ?? newRequestId(), prefer: 'return=representation' }),
  );
}

/**
 * Order the buyer approves in the browser (payer present), used for step-up: a purchase outside the
 * instructions goes ahead only if the buyer approves this exact payment at PayPal.
 */
export function createBuyerApprovalOrder(
  input: Omit<VaultOrderInput, 'vaultId' | 'source'> & { returnUrl: string; cancelUrl: string },
  requestId: string,
): Promise<PPResponse> {
  return callSdk('POST /v2/checkout/orders (buyer approval)', () =>
    sdk().orders.createOrder({
      paypalRequestId: requestId,
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
        paymentSource: {
          paypal: {
            experienceContext: {
              brandName: 'Recourse',
              locale: 'en-US',
              shippingPreference: PaypalWalletContextShippingPreference.NoShipping,
              userAction: PaypalExperienceUserAction.PayNow,
              returnUrl: input.returnUrl,
              cancelUrl: input.cancelUrl,
            },
          },
        },
      },
    }),
  );
}

/** POST /v2/checkout/orders/{id}/track: shipment tracker on a capture. */
export function addTracker(orderId: string, captureId: string, trackingNumber: string, carrierName: string): Promise<PPResponse> {
  return callSdk(`POST /v2/checkout/orders/${orderId}/track`, () =>
    sdk().orders.createOrderTracking({
      id: orderId,
      body: { captureId, trackingNumber, carrier: ShipmentCarrier.Other, carrierNameOther: carrierName, notifyPayer: false },
    }),
  );
}

export function getOrder(id: string): Promise<PPResponse> {
  return callSdk(`GET /v2/checkout/orders/${id}`, () => sdk().orders.getOrder({ id }));
}

/** First capture of the first purchase unit, from an order body. */
export function firstCapture(order: any): any | undefined {
  return order?.purchase_units?.[0]?.payments?.captures?.[0];
}
