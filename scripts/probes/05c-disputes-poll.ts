// Probe 5c: polling fallback for webhooks. Lists disputes and prints each new one or each change of
// status / update_time. --once lists once, and saves the newest dispute as DISPUTE_ID if none is saved.
// Usage: npx tsx scripts/probes/05c-disputes-poll.ts [--once]   (POLL_SECONDS, default 30)
import { env, flag, getValue, saveValues } from '../lib/env';
import { pp } from '../lib/http';
import { show } from '../lib/print';

const once = flag('once');
const every = Number(env('POLL_SECONDS', '30')) * 1000;
const seen = new Map<string, string>();

async function poll(first: boolean): Promise<void> {
  const res = await pp('GET', '/v1/customer/disputes', { query: { page_size: '50' } });
  if (first) show('GET /v1/customer/disputes', res);
  if (res.status >= 300) {
    if (!first) show('GET /v1/customer/disputes', res);
    return;
  }
  const items: any[] = res.body.items ?? [];
  for (const d of items) {
    const key = `${d.status}|${d.update_time}`;
    if (seen.get(d.dispute_id) === key) continue;
    const verb = seen.has(d.dispute_id) ? 'CHANGED' : first ? 'EXISTING' : 'NEW';
    seen.set(d.dispute_id, key);
    console.log(
      `${new Date().toISOString()} ${verb.padEnd(8)} ${d.dispute_id} status=${d.status} state=${d.dispute_state ?? '-'} ` +
        `reason=${d.reason} amount=${d.dispute_amount?.value ?? '-'} ${d.dispute_amount?.currency_code ?? ''} updated=${d.update_time}`,
    );
  }
  if (once && items.length && !getValue('DISPUTE_ID')) {
    const newest = [...items].sort((a, b) => String(b.create_time).localeCompare(String(a.create_time)))[0];
    saveValues({ DISPUTE_ID: newest.dispute_id });
  }
}

await poll(true);
if (!once) {
  console.log(`\nPolling every ${every / 1000}s. Ctrl+C to stop.`);
  setInterval(() => poll(false).catch((e) => console.error(e)), every);
}
