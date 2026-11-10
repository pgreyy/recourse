// Probe 4b: GET a dispute and print its status and every HATEOAS link.
// Usage: npx tsx scripts/probes/04b-dispute-get.ts [disputeId]
import { args, requireValue } from '../lib/env';
import { pp } from '../lib/http';
import { show, showLinks } from '../lib/print';

const id = args()[0] ?? requireValue('DISPUTE_ID', 'Run 04a-dispute-create.ts or 05c-disputes-poll.ts --once first.');
const res = show(`GET /v1/customer/disputes/${id}`, await pp('GET', `/v1/customer/disputes/${id}`));
if (res.status >= 300) process.exit(1);

const d = res.body;
console.log('\n--- summary');
console.log(`status:            ${d.status}`);
console.log(`stage:             ${d.dispute_life_cycle_stage}`);
console.log(`reason:            ${d.reason}`);
console.log(`dispute_channel:   ${d.dispute_channel ?? '-'}`);
console.log(`seller_response_due_date: ${d.seller_response_due_date ?? '-'}`);
console.log(`buyer_response_due_date:  ${d.buyer_response_due_date ?? '-'}`);
console.log(`dispute_outcome:   ${d.dispute_outcome ? JSON.stringify(d.dispute_outcome) : '-'}`);
console.log('links:');
showLinks(d.links);
console.log(`\nLINKS AT ${d.status}: ${(d.links ?? []).map((l: { rel: string }) => l.rel).join(', ')}`);
