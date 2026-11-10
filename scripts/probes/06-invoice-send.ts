// Probe 6: create and send an invoice from the merchant to the agent operator (OPERATOR_EMAIL).
// This is the fallback path when the operator's vaulted payment method cannot be charged.
// Usage: npx tsx scripts/probes/06-invoice-send.ts [amount]   (default 25.00)
import { args, currency, getValue, need, saveValues } from '../lib/env';
import { pp } from '../lib/http';
import { show, showLinks } from '../lib/print';

const amount = args()[0] ?? '25.00';
const caseRef = `RCS-CASE-TEST-${Date.now()}`;

const next = show(
  'POST /v2/invoicing/generate-next-invoice-number',
  await pp('POST', '/v2/invoicing/generate-next-invoice-number', { json: {} }),
);
// invoice_number must be under 25 characters.
const invoiceNumber: string = next.body?.invoice_number ?? `RCS-${Date.now().toString(36)}`;

const created = show(
  'POST /v2/invoicing/invoices',
  await pp('POST', '/v2/invoicing/invoices', {
    headers: { Prefer: 'return=representation' },
    json: {
      detail: {
        invoice_number: invoiceNumber,
        reference: caseRef,
        currency_code: currency(),
        note: 'Recourse ruling: agent fault. Reimbursement of the buyer refund.',
        memo: `Sandbox probe 6. Related capture: ${getValue('CAPTURE_ID') ?? 'none'}`,
        payment_term: { term_type: 'DUE_ON_RECEIPT' },
      },
      invoicer: { business_name: 'Recourse sandbox merchant' },
      primary_recipients: [{ billing_info: { email_address: need('OPERATOR_EMAIL') } }],
      items: [
        {
          name: 'Agent fault liability',
          description: `Case ${caseRef}`,
          quantity: '1',
          unit_amount: { currency_code: currency(), value: amount },
          unit_of_measure: 'AMOUNT',
        },
      ],
    },
  }),
);
if (created.status >= 300) process.exit(1);

// With Prefer: return=representation the body is the invoice; without it, only a link.
const invoiceId: string = created.body.id ?? String(created.body.href ?? '').split('/').pop();
saveValues({ INVOICE_ID: invoiceId });

const sent = show(
  `POST /v2/invoicing/invoices/${invoiceId}/send`,
  await pp('POST', `/v2/invoicing/invoices/${invoiceId}/send`, {
    json: {
      send_to_invoicer: false,
      send_to_recipient: true,
      subject: 'Recourse: agent fault liability invoice (sandbox)',
    },
  }),
);

const got = show(`GET /v2/invoicing/invoices/${invoiceId}`, await pp('GET', `/v2/invoicing/invoices/${invoiceId}`));
console.log(`\nInvoice ${invoiceId}  status: ${got.body.status}  send HTTP ${sent.status}`);
console.log('Links:');
showLinks(got.body.links);
const payerView = got.body.detail?.metadata?.recipient_view_url;
if (payerView) console.log(`\nRecipient view (pay as the operator sandbox account): ${payerView}`);
