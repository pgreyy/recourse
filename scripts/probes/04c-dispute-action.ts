// Probe 4c: run one dispute action through its HATEOAS link, then GET the dispute again
// and print the new status and links. Used to fill the action/status table in docs/phase0-findings.md.
//
// Usage: npx tsx scripts/probes/04c-dispute-action.ts <rel> ['<json body>'] [--buyer] [--force] [--file=path ...]
//   rel        accept_claim | provide_evidence | make_offer | send_message | acknowledge_return_item |
//              require_evidence | adjudicate | escalate | ... (the rel names PayPal returns; "-" and "_" both work)
//   --buyer    send a PayPal-Auth-Assertion for BUYER_EMAIL (buyer-side actions such as escalate)
//   --force    POST to /v1/customer/disputes/{id}/{rel} even if the link is missing, to record the error
//   --file=    attach evidence files (multipart). Used with provide_evidence / provide_supporting_info.
// Default bodies (override with the json argument):
//   require_evidence  {"action":"SELLER_EVIDENCE"}       (sandbox only; BUYER_EVIDENCE also valid)
//   adjudicate        {"adjudication_outcome":"BUYER_FAVOR"}  (sandbox only; SELLER_FAVOR also valid)
import { readFileSync } from 'node:fs';
import { basename, extname } from 'node:path';
import { args, currency, flag, need, requireValue } from '../lib/env';
import { authAssertion, pp, type Part } from '../lib/http';
import { show, showLinks } from '../lib/print';

const [rawRel, rawBody] = args();
if (!rawRel) {
  console.error('Usage: 04c-dispute-action.ts <rel> [json body] [--buyer] [--force] [--file=path]');
  process.exit(1);
}
const rel = rawRel.replace(/_/g, '-');
const id = requireValue('DISPUTE_ID', 'Run 04a or 05c --once first.');
const ccy = currency();

const defaults: Record<string, unknown> = {
  'require-evidence': { action: 'SELLER_EVIDENCE' },
  adjudicate: { adjudication_outcome: 'BUYER_FAVOR' },
  'accept-claim': { note: 'Recourse probe: accepting claim.' },
  'make-offer': {
    note: 'Recourse probe: partial refund offer.',
    offer_amount: { currency_code: ccy, value: '5.00' },
    offer_type: 'REFUND',
  },
  'send-message': { message: 'Recourse probe message.' },
  escalate: { note: 'Recourse probe: escalating to claim.' },
  'provide-evidence': {
    evidences: [{ evidence_type: 'ITEM_DESCRIPTION', notes: 'Recourse probe: signed instructions and receipt attached.' }],
  },
};

const before = await pp('GET', `/v1/customer/disputes/${id}`);
console.log(`Before: status ${before.body.status}`);
showLinks(before.body.links);

const link = (before.body.links ?? []).find(
  (l: { rel: string }) => l.rel.replace(/_/g, '-').toLowerCase() === rel.toLowerCase(),
);
if (!link && !flag('force')) {
  console.log(`\nNo "${rel}" link at status ${before.body.status}. Not calling. Use --force to call anyway and record the error.`);
  process.exit(1);
}
const href: string = link?.href ?? `/v1/customer/disputes/${id}/${rel}`;
const body = rawBody ? JSON.parse(rawBody) : (defaults[rel] ?? {});
const headers: Record<string, string> = flag('buyer') ? { 'PayPal-Auth-Assertion': authAssertion(need('BUYER_EMAIL')) } : {};

const files = process.argv.filter((a) => a.startsWith('--file=')).map((a) => a.slice('--file='.length));
const mime: Record<string, string> = { '.pdf': 'application/pdf', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif' };
const multipartRels = ['provide-evidence', 'provide-supporting-info', 'appeal'];

let res;
if (multipartRels.includes(rel)) {
  const parts: Part[] = [{ name: 'input', contentType: 'application/json', data: JSON.stringify(body) }];
  for (const f of files) {
    parts.push({ name: 'evidence-file', filename: basename(f), contentType: mime[extname(f).toLowerCase()] ?? 'application/octet-stream', data: readFileSync(f) });
  }
  res = await pp(link?.method ?? 'POST', href, { headers, parts });
} else {
  res = await pp(link?.method ?? 'POST', href, { headers, json: body });
}
show(`${link?.method ?? 'POST'} ${href}${link ? '' : ' (forced, no link)'}`, res);

const after = await pp('GET', `/v1/customer/disputes/${id}`);
console.log(`\nAfter: status ${after.body.status}  stage ${after.body.dispute_life_cycle_stage}`);
showLinks(after.body.links);
console.log(`\nLINKS AT ${after.body.status}: ${(after.body.links ?? []).map((l: { rel: string }) => l.rel).join(', ')}`);
