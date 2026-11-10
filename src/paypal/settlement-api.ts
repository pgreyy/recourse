import { pp, type Part } from './http';
import { callSdk, sdk } from './sdk';
import type { PPResponse } from './types';

/** Payments v2: refund a capture. requestId is the PayPal-Request-Id (same id => PayPal returns the original refund). */
export function refundCapture(captureId: string, amount: { value: string; currency: string }, requestId: string, note: string, invoiceId?: string): Promise<PPResponse> {
  return callSdk(`POST /v2/payments/captures/${captureId}/refund`, () =>
    sdk().payments.refundCapturedPayment({
      captureId,
      paypalRequestId: requestId,
      prefer: 'return=representation',
      body: { amount: { currencyCode: amount.currency, value: amount.value }, noteToPayer: note.slice(0, 255), invoiceId },
    }),
  );
}

export function getCapture(captureId: string): Promise<PPResponse> {
  return callSdk(`GET /v2/payments/captures/${captureId}`, () => sdk().payments.getCapturedPayment({ captureId }));
}

export function getRefund(refundId: string): Promise<PPResponse> {
  return callSdk(`GET /v2/payments/refunds/${refundId}`, () => sdk().payments.getRefund({ refundId }));
}

/** Invoicing v2: create and send an invoice (fallback when the operator's saved PayPal can't be charged). */
export async function createAndSendInvoice(input: { recipientEmail: string; amount: string; currency: string; reference: string; note: string; item: string }) {
  const num = await pp('POST', '/v2/invoicing/generate-next-invoice-number', { json: {} });
  const invoiceNumber: string = num.body?.invoice_number ?? input.reference.slice(0, 24);
  const created = await pp('POST', '/v2/invoicing/invoices', {
    headers: { Prefer: 'return=representation' },
    json: {
      detail: { invoice_number: invoiceNumber, reference: input.reference, currency_code: input.currency, note: input.note.slice(0, 4000), payment_term: { term_type: 'DUE_ON_RECEIPT' } },
      invoicer: { business_name: 'Recourse' },
      primary_recipients: [{ billing_info: { email_address: input.recipientEmail } }],
      items: [{ name: input.item.slice(0, 200), quantity: '1', unit_amount: { currency_code: input.currency, value: input.amount }, unit_of_measure: 'AMOUNT' }],
    },
  });
  const invoiceId: string | undefined = created.body?.id ?? String(created.body?.href ?? '').split('/').pop();
  if (created.status >= 300 || !invoiceId) return { created, sent: null as PPResponse | null, invoiceId: null as string | null };
  const sent = await pp('POST', `/v2/invoicing/invoices/${invoiceId}/send`, { json: { send_to_invoicer: false, send_to_recipient: true, subject: 'Recourse: agent fault liability' } });
  return { created, sent, invoiceId };
}

export function getInvoice(id: string): Promise<PPResponse> {
  return pp('GET', `/v2/invoicing/invoices/${id}`);
}

export function getDispute(id: string): Promise<PPResponse> {
  return pp('GET', `/v1/customer/disputes/${id}`);
}

/** Run a dispute action through the HATEOAS link PayPal returned (never a guessed URL). */
export function disputeAction(link: { href: string; method?: string }, body: unknown, files?: Part[]): Promise<PPResponse> {
  if (files?.length) {
    return pp(link.method ?? 'POST', link.href, { parts: [{ name: 'input', contentType: 'application/json', data: JSON.stringify(body) }, ...files] });
  }
  return pp(link.method ?? 'POST', link.href, { json: body });
}

export function findLink(dispute: any, rel: string): { href: string; method?: string } | undefined {
  return (dispute?.links ?? []).find((l: { rel: string }) => l.rel.replace(/-/g, '_') === rel);
}
