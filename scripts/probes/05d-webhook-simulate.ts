// Probe 5d: ask PayPal's simulator to send a sample event to the registered webhook.
// Simulated events do not pass signature verification; run 05 with WEBHOOK_ALLOW_UNVERIFIED=1 to accept them.
// Usage: npx tsx scripts/probes/05d-webhook-simulate.ts [EVENT_TYPE]   (default CUSTOMER.DISPUTE.CREATED)
import { args, requireValue } from '../lib/env';
import { pp } from '../lib/http';
import { show } from '../lib/print';

const eventType = args()[0] ?? 'CUSTOMER.DISPUTE.CREATED';
show(
  `POST /v1/notifications/simulate-event (${eventType})`,
  await pp('POST', '/v1/notifications/simulate-event', {
    json: { webhook_id: requireValue('WEBHOOK_ID', 'Run 05b-webhook-register.ts first.'), event_type: eventType },
  }),
);
