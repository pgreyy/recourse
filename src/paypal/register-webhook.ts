// npm run webhook:register [-- <public https base url>]   (default: PUBLIC_BASE_URL)
// Points the PayPal webhook at <base>/webhooks/paypal. Updates the webhook named by WEBHOOK_ID in place
// (same id, so signature checks keep working), or creates one and prints the WEBHOOK_ID to add to .env.
import '../config';
import { config, env } from '../config';
import { pp } from './http';

const EVENT_TYPES = ['CUSTOMER.DISPUTE.CREATED', 'CUSTOMER.DISPUTE.UPDATED', 'CUSTOMER.DISPUTE.RESOLVED', 'INVOICING.INVOICE.PAID', 'PAYMENT.CAPTURE.REFUNDED', 'PAYMENT.CAPTURE.COMPLETED'];

async function main() {
  const base = (process.argv[2] ?? env('WEBHOOK_BASE_URL') ?? config.publicBaseUrl()).replace(/\/$/, '');
  if (!/^https:\/\//.test(base)) throw new Error('Set PUBLIC_BASE_URL to the public https address (or pass it: npm run webhook:register -- https://your-app.onrender.com).');
  const url = `${base}/webhooks/paypal`;
  const id = env('WEBHOOK_ID');
  const types = EVENT_TYPES.map((name) => ({ name }));
  if (id) {
    const r = await pp('PATCH', `/v1/notifications/webhooks/${id}`, {
      json: [
        { op: 'replace', path: '/url', value: url },
        { op: 'replace', path: '/event_types', value: types },
      ],
    });
    console.log(`PATCH webhook ${id}: HTTP ${r.status} debug ${r.debugId} url ${r.body?.url ?? JSON.stringify(r.body)}`);
    console.log(`event types: ${(r.body?.event_types ?? []).map((t: { name: string }) => t.name).join(', ')}`);
  } else {
    const r = await pp('POST', '/v1/notifications/webhooks', { json: { url, event_types: types } });
    console.log(`POST webhook: HTTP ${r.status} debug ${r.debugId}`);
    if (r.body?.id) console.log(`Add to .env: WEBHOOK_ID=${r.body.id}`);
    else console.log(JSON.stringify(r.body));
  }
}
main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
