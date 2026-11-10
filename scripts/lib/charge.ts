import { createHash } from 'node:crypto';
import { captureOrder, createVaultOrder, getOrder } from '../../src/paypal/orders';
import { currency, saveValues } from './env';
import { printed } from './sdk';

export type ChargeInput = {
  vaultId: string;
  source: 'paypal' | 'card';
  amount: string;
  description: string;
  /** Prefix for saved values, e.g. "" for the buyer order or "OPERATOR_" for probe 8. */
  savePrefix: string;
};

/**
 * Probe 3 shape: create an order with a vault_id (payer not present), capture it if it is
 * not already completed, then GET it and check that custom_id came back.
 */
export async function chargeVault(input: ChargeInput): Promise<void> {
  // Stand-in for the signed instructions the agent will carry in Phase 1. Its sha256 is the custom_id.
  const mandate = {
    kind: 'recourse.test-mandate',
    created: new Date().toISOString(),
    amount: { currency_code: currency(), value: input.amount },
    description: input.description,
  };
  const customId = createHash('sha256').update(JSON.stringify(mandate)).digest('hex');
  const invoiceRef = `RCS-TEST-${Date.now()}`;
  console.log('custom_id preimage:', JSON.stringify(mandate));
  console.log(`custom_id (sha256, ${customId.length} chars): ${customId}`);
  console.log(`invoice_id: ${invoiceRef}`);

  const created = await printed(
    'POST /v2/checkout/orders (vault_id, payer not present)',
    createVaultOrder({
      vaultId: input.vaultId,
      source: input.source,
      amount: input.amount,
      currency: currency(),
      customId,
      invoiceId: invoiceRef,
      description: input.description,
    }),
  );
  if (created.status >= 300) process.exit(1);
  const orderId: string = created.body.id;

  let order = created.body;
  if (order.status === 'COMPLETED') {
    console.log('\nOrder came back COMPLETED on create: no separate capture call needed.');
  } else {
    console.log(`\nOrder status after create: ${order.status}. Capturing.`);
    const captured = await printed(`POST /v2/checkout/orders/${orderId}/capture`, captureOrder(orderId));
    if (captured.status >= 300) process.exit(1);
    order = captured.body;
  }

  const fetched = await printed(`GET /v2/checkout/orders/${orderId}`, getOrder(orderId));
  const unit = fetched.body.purchase_units?.[0];
  const capture = unit?.payments?.captures?.[0] ?? order.purchase_units?.[0]?.payments?.captures?.[0];

  console.log('\n--- custom_id check');
  console.log(`sent:                       ${customId}`);
  console.log(`GET order purchase_unit:    ${unit?.custom_id ?? '(missing)'}`);
  console.log(`GET order capture:          ${capture?.custom_id ?? '(missing)'}`);
  console.log(`invoice_id on capture:      ${capture?.invoice_id ?? '(missing)'}`);
  console.log(unit?.custom_id === customId ? 'RESULT: custom_id returned intact' : 'RESULT: custom_id NOT returned intact');

  saveValues({
    [`${input.savePrefix}ORDER_ID`]: orderId,
    [`${input.savePrefix}CAPTURE_ID`]: capture?.id,
    [`${input.savePrefix}CAPTURE_AMOUNT`]: capture?.amount?.value,
    [`${input.savePrefix}CUSTOM_ID`]: customId,
    [`${input.savePrefix}INVOICE_REF`]: invoiceRef,
  });
}
