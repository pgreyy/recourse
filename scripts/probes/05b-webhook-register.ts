// Probe 5b: list webhooks and register WEBHOOK_URL for the event types Recourse needs.
// Also checks that each event type exists in GET /v1/notifications/webhooks-event-types.
// Usage: WEBHOOK_URL=https://<public-host>/webhook npx tsx scripts/probes/05b-webhook-register.ts
import { env, saveValues } from '../lib/env';
import { pp } from '../lib/http';
import { show } from '../lib/print';

const EVENT_TYPES = [
  'CUSTOMER.DISPUTE.CREATED',
  'CUSTOMER.DISPUTE.UPDATED',
  'INVOICING.INVOICE.PAID',
  'PAYMENT.CAPTURE.REFUNDED',
];

const types = await pp('GET', '/v1/notifications/webhooks-event-types');
const known = new Set<string>((types.body.event_types ?? []).map((t: { name: string }) => t.name));
console.log(`Event types available to this app: ${known.size}`);
for (const t of EVENT_TYPES) console.log(`  ${t.padEnd(28)} ${known.has(t) ? 'available' : 'NOT LISTED'}`);
const disputeTypes = [...known].filter((n) => n.startsWith('CUSTOMER.DISPUTE')).sort();
console.log(`Other dispute event types listed: ${disputeTypes.join(', ')}`);

const list = show('GET /v1/notifications/webhooks', await pp('GET', '/v1/notifications/webhooks'));

const url = env('WEBHOOK_URL');
if (!url) {
  console.log('\nWEBHOOK_URL not set; not creating a webhook.');
  process.exit(0);
}
const existing = (list.body.webhooks ?? []).find((w: { url: string }) => w.url === url);
if (existing) {
  console.log(`\nWebhook for ${url} already exists: ${existing.id}`);
  saveValues({ WEBHOOK_ID: existing.id });
  process.exit(0);
}

const created = show(
  'POST /v1/notifications/webhooks',
  await pp('POST', '/v1/notifications/webhooks', {
    json: { url, event_types: EVENT_TYPES.map((name) => ({ name })) },
  }),
);
if (created.status >= 300) process.exit(1);
saveValues({ WEBHOOK_ID: created.body.id });
console.log('Restart 05-webhook-server.ts so it picks up WEBHOOK_ID for signature checks.');
