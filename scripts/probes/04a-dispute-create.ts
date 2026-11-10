// Probe 4a: create a sandbox dispute as the buyer.
// POST /v1/customer/disputes, multipart/form-data with an "input" part (application/json),
// PayPal-Auth-Assertion = unsigned JWT {iss: client_id, email: BUYER_EMAIL}.
// Usage: npx tsx scripts/probes/04a-dispute-create.ts [transactionId]
//   DISPUTE_TXN_FIELD=seller_transaction_id  to send the capture id as the seller-side id instead.
// If this endpoint fails, the fallback is opening the case as the sandbox buyer in the sandbox
// Resolution Center, then running 05c-disputes-poll.ts --once to pick up the dispute id.
import { args, currency, env, getValue, need, requireValue, saveValues } from '../lib/env';
import { authAssertion, pp } from '../lib/http';
import { show, showLinks } from '../lib/print';

const txnId = args()[0] ?? requireValue('CAPTURE_ID', 'Run 03-order-vault-capture.ts first.');
const txnField = env('DISPUTE_TXN_FIELD', 'buyer_transaction_id')!;
const amount = env('DISPUTE_AMOUNT', getValue('CAPTURE_AMOUNT') ?? '25.00')!;

const input = {
  disputed_transactions: [{ [txnField]: txnId }],
  reason: 'MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED',
  dispute_amount: { currency_code: currency(), value: amount },
  extensions: {
    merchant_contacted: false,
    merchandize_dispute_properties: { issue_type: 'PRODUCT' },
  },
};
console.log('input part:', JSON.stringify(input, null, 2));

const res = show(
  'POST /v1/customer/disputes',
  await pp('POST', '/v1/customer/disputes', {
    headers: { 'PayPal-Auth-Assertion': authAssertion(need('BUYER_EMAIL')) },
    parts: [{ name: 'input', contentType: 'application/json', data: JSON.stringify(input) }],
  }),
);

if (res.status >= 300) {
  console.log('\nCreate dispute FAILED. Note the name and debug id above in docs/phase0-findings.md.');
  console.log('Retry with DISPUTE_TXN_FIELD=seller_transaction_id, or use the fallback:');
  console.log('  log in at https://www.sandbox.paypal.com as the buyer, open the payment, "Report a problem",');
  console.log('  then: npx tsx scripts/probes/05c-disputes-poll.ts --once');
  process.exit(1);
}

console.log('\nLinks:');
showLinks(res.body.links);
const self: string | undefined = res.body.links?.find((l: { rel: string }) => l.rel === 'self')?.href;
const disputeId = res.body.dispute_id ?? self?.split('/').pop();
saveValues({ DISPUTE_ID: disputeId });
console.log('Next: npx tsx scripts/probes/04b-dispute-get.ts');
