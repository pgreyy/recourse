// Probe 5: tiny webhook receiver. Logs every event to the console and .local/webhook-events.jsonl,
// and verifies the signature with POST /v1/notifications/verify-webhook-signature.
//
// Events sent by the dashboard's Webhooks Simulator cannot be verified (PayPal says so), so a FAILURE
// is rejected with 401 unless WEBHOOK_ALLOW_UNVERIFIED=1 (set that only while using the simulator).
// Also serves /return and /cancel for the vault approval redirect (probe 2a).
//
// Usage: npx tsx scripts/probes/05-webhook-server.ts   (PORT, default 8787)
// PayPal needs a public https URL: put a tunnel in front of this port and register <tunnel>/webhook with 05b.
import express from 'express';
import { appendFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { env, getValue, LOCAL_DIR } from '../lib/env';
import { pp } from '../lib/http';

const port = Number(env('PORT', '8787'));
const allowUnverified = env('WEBHOOK_ALLOW_UNVERIFIED') === '1';
const app = express();

async function verify(headers: express.Request['headers'], event: unknown): Promise<string> {
  const webhookId = getValue('WEBHOOK_ID');
  if (!webhookId) return 'SKIPPED (no WEBHOOK_ID; run 05b-webhook-register.ts)';
  if (!headers['paypal-transmission-sig']) return 'MISSING_SIGNATURE (no paypal-transmission-sig header)';
  const res = await pp('POST', '/v1/notifications/verify-webhook-signature', {
    json: {
      auth_algo: headers['paypal-auth-algo'],
      cert_url: headers['paypal-cert-url'],
      transmission_id: headers['paypal-transmission-id'],
      transmission_sig: headers['paypal-transmission-sig'],
      transmission_time: headers['paypal-transmission-time'],
      webhook_id: webhookId,
      webhook_event: event,
    },
  });
  if (res.status !== 200) return `ERROR HTTP ${res.status} ${JSON.stringify(res.body)} debug-id ${res.debugId}`;
  return res.body.verification_status;
}

app.post('/webhook', express.raw({ type: '*/*', limit: '2mb' }), async (req, res) => {
  const raw = req.body.toString('utf8');
  let event: any;
  try {
    event = JSON.parse(raw);
  } catch {
    console.log('Non-JSON body:', raw);
    return res.sendStatus(400);
  }
  const verification = await verify(req.headers, event);
  const accepted = verification === 'SUCCESS' || verification.startsWith('SKIPPED') || allowUnverified;

  console.log(`\n=== ${new Date().toISOString()}  ${event.event_type}  ${event.id}`);
  console.log(`verification: ${verification}${accepted ? '' : '  -> rejected (401)'}`);
  console.log(`resource_type: ${event.resource_type}  summary: ${event.summary}`);
  const r = event.resource ?? {};
  const keyFields = { id: r.id ?? r.dispute_id, status: r.status, reason: r.reason, invoice_id: r.invoice_id, custom_id: r.custom_id };
  console.log('key fields:', JSON.stringify(keyFields));
  console.log('headers:', JSON.stringify(Object.fromEntries(Object.entries(req.headers).filter(([k]) => k.startsWith('paypal-')))));
  console.log('event:', JSON.stringify(event, null, 2));

  mkdirSync(LOCAL_DIR, { recursive: true });
  appendFileSync(
    resolve(LOCAL_DIR, 'webhook-events.jsonl'),
    JSON.stringify({ received: new Date().toISOString(), verification, headers: req.headers, event }) + '\n',
  );
  res.sendStatus(accepted ? 200 : 401);
});

for (const path of ['/return', '/cancel']) {
  app.get(path, (req, res) => {
    console.log(`\n=== ${path}`, JSON.stringify(req.query));
    res.type('text').send(`${path.slice(1)} received.\n${JSON.stringify(req.query, null, 2)}\nYou can close this tab and run the next probe.`);
  });
}

app.get('/', (_req, res) => {
  res.type('text').send('Recourse probe webhook receiver. POST /webhook');
});

app.listen(port, () => {
  console.log(`Webhook receiver on http://localhost:${port}/webhook`);
  console.log(`Signature check: ${getValue('WEBHOOK_ID') ? `on (webhook ${getValue('WEBHOOK_ID')})` : 'off until WEBHOOK_ID is set'}`);
  if (allowUnverified) console.log('WEBHOOK_ALLOW_UNVERIFIED=1: failed signatures are logged but accepted (simulator mode).');
});
