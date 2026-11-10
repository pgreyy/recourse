import {
  ExperienceContextShippingPreference,
  PaypalPaymentTokenCustomerType,
  PaypalPaymentTokenUsageType,
  UsagePattern,
  VaultTokenRequestType,
  VaultUserAction,
} from '@paypal/paypal-server-sdk';
import { requestId } from './http';
import { callSdk, sdk } from './sdk';
import type { PPResponse } from './types';

export type SetupTokenInput = {
  description: string;
  returnUrl: string;
  cancelUrl: string;
  /** Defaults to IMMEDIATE, which Phase 0 showed is enough for later payer-not-present charges. */
  usagePattern?: string;
  brandName?: string;
};

/**
 * POST /v3/vault/setup-tokens for a PayPal wallet. The body is the one that worked in Phase 0
 * (docs/phase0-findings.md, app 2): MERCHANT / CONSUMER, NO_SHIPPING, user_action CONTINUE.
 */
export function createPaypalSetupToken(input: SetupTokenInput): Promise<PPResponse> {
  return callSdk('POST /v3/vault/setup-tokens', () =>
    sdk().vault.createSetupToken({
      paypalRequestId: requestId(),
      body: {
        paymentSource: {
          paypal: {
            description: input.description,
            usagePattern: (input.usagePattern ?? 'IMMEDIATE') as UsagePattern,
            usageType: PaypalPaymentTokenUsageType.Merchant,
            customerType: PaypalPaymentTokenCustomerType.Consumer,
            permitMultiplePaymentTokens: false,
            experienceContext: {
              brandName: input.brandName ?? 'Recourse',
              locale: 'en-US',
              shippingPreference: ExperienceContextShippingPreference.NoShipping,
              userAction: VaultUserAction.Continue,
              returnUrl: input.returnUrl,
              cancelUrl: input.cancelUrl,
            },
          },
        },
      },
    }),
  );
}

export function getSetupToken(id: string): Promise<PPResponse> {
  return callSdk(`GET /v3/vault/setup-tokens/${id}`, () => sdk().vault.getSetupToken(id));
}

/** POST /v3/vault/payment-tokens from an approved setup token. The response `id` is the vault_id. */
export function createPaymentToken(setupTokenId: string): Promise<PPResponse> {
  return callSdk('POST /v3/vault/payment-tokens', () =>
    sdk().vault.createPaymentToken({
      paypalRequestId: requestId(),
      body: { paymentSource: { token: { id: setupTokenId, type: VaultTokenRequestType.SetupToken } } },
    }),
  );
}

/** The payer approval link from a setup token or order response. */
export function approveLink(body: { links?: Array<{ rel: string; href: string }> }): string | undefined {
  return body.links?.find((l) => l.rel === 'approve' || l.rel === 'payer-action')?.href;
}
