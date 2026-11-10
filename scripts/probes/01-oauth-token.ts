// Probe 1: OAuth token from PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET (sandbox).
// access_token is masked in the output; set SHOW_TOKEN=1 to print it in full.
import { requestToken } from '../lib/http';
import { show } from '../lib/print';

const res = show('POST /v1/oauth2/token (client_credentials)', await requestToken());
if (res.status === 200) {
  console.log(`\napp_id: ${res.body.app_id}`);
  console.log(`expires_in: ${res.body.expires_in}s`);
  console.log('scopes:');
  for (const s of String(res.body.scope ?? '').split(' ').sort()) console.log(`  ${s}`);
  const want = ['disputes/create', 'invoicing', 'vault/payment-tokens/readwrite', 'applications/webhooks'];
  console.log('\nScope check (substring match):');
  for (const w of want) console.log(`  ${w.padEnd(24)} ${String(res.body.scope).includes(w) ? 'present' : 'NOT PRESENT'}`);
}
