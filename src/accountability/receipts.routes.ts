import { Router } from 'express';
import { route } from '../shared/http/errors';
import { confirmReceipt, loadReceipt, parseReceiptToken, reportIssue, type ReceiptView } from './receipts';

export const receipts = Router();

const esc = (s: unknown) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

const STATUS = {
  COMPLIANT: { label: 'Compliant', cls: 'ok', text: 'Everything checked matches your instructions.' },
  WARNING: { label: 'Warning', cls: 'warn', text: 'Bought within your instructions, but some details could not be verified.' },
  VIOLATION_APPROVED: { label: 'Violation (you approved it)', cls: 'bad', text: 'This purchase broke one of your instructions and went ahead only after you approved it at PayPal.' },
} as const;

const day = (d: string | Date) => {
  const t = new Date(d);
  return `${t.getUTCDate()} ${t.toLocaleString('en-GB', { month: 'short', timeZone: 'UTC' })}`;
};
const VERDICT_WORDS: Record<string, string> = { AGENT_FAULT: 'agent fault', MERCHANT_FAULT: 'merchant fault', BUYER_REMORSE: "buyer's remorse", THIRD_PARTY_FAULT: 'third-party fault' };

/** The outcome line at the bottom of the receipt, from the confirmed settlement (or the ruling, when nothing is refunded). */
function outcome(r: NonNullable<ReceiptView>): string {
  const f = r.refund as { value: string; currency: string; confirmation: string; confirmed_at: string | null; completed_at: string | null; refund_id: string | null } | null;
  const ru = r.ruling as { verdict: string; status: string; approved_at: string; case_status: string; source: string } | null;
  if (f && f.confirmation === 'confirmed') {
    return `<section class="sec outcome ok" role="status"><h2>Outcome</h2><p><strong>Resolved: refunded ${esc(f.value)} ${esc(f.currency.trim())} on ${esc(day(f.confirmed_at ?? f.completed_at!))}.</strong></p><p class="muted">Confirmed by PayPal${f.refund_id ? `, refund ${esc(f.refund_id)}` : ''}.${ru?.verdict === 'AGENT_FAULT' ? " The agent's operator covers the cost." : ''} You do not need to file a dispute.</p></section>`;
  }
  if (f) {
    return `<section class="sec outcome" role="status"><h2>Outcome</h2><p><strong>Refund of ${esc(f.value)} ${esc(f.currency.trim())} issued on ${esc(day(f.completed_at!))}.</strong></p><p class="muted">Waiting for PayPal to confirm it.</p></section>`;
  }
  if (!ru) return '';
  const v = VERDICT_WORDS[ru.verdict] ?? ru.verdict.toLowerCase().replace(/_/g, ' ');
  if (ru.case_status === 'CLOSED') {
    return `<section class="sec outcome" role="status"><h2>Outcome</h2><p><strong>Resolved on ${esc(day(ru.approved_at))}: no refund.</strong></p><p class="muted">The decision found ${esc(v)}.</p></section>`;
  }
  const where = ru.source === 'PAYPAL_DISPUTE' ? ' Your PayPal dispute is still under review at PayPal, which makes the final decision.' : '';
  return `<section class="sec outcome" role="status"><h2>Outcome</h2><p><strong>Decision on ${esc(day(ru.approved_at))}: ${esc(v)}.</strong></p><p class="muted">Not resolved yet.${where}</p></section>`;
}

const CASE_STATUS: Record<string, string> = { OPEN: 'open', ASSESSED: 'being reviewed', RULING_APPROVED: 'decided', APPEALED: 'under appeal', CLOSED: 'closed' };
function caseLine(c: { case_ref: string; status: string; source?: string }): string {
  const how = c.source === 'PAYPAL_DISPUTE' ? 'You opened a PayPal dispute' : 'You reported an issue';
  return `<p class="warn">${how}. Case ${esc(c.case_ref)} is ${esc(CASE_STATUS[c.status] ?? c.status.toLowerCase().replace(/_/g, ' '))}.</p>`;
}

/** The header of a page outside the app shell: Back (history, or the app when there is none) and the logo, which goes home. */
const HEADER = `<header><button type="button" class="back" id="back" aria-label="Back"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 5l-7 7 7 7"/></svg>Back</button><a class="home" href="/app/" aria-label="Recourse, home"><svg viewBox="0 0 32 32" width="26" height="26" aria-hidden="true"><polygon points="16.00,0.60 17.84,2.02 19.99,1.12 21.40,2.97 23.70,2.66 24.58,4.81 26.89,5.11 27.19,7.42 29.34,8.30 29.03,10.60 30.88,12.01 29.98,14.16 31.40,16.00 29.98,17.84 30.88,19.99 29.03,21.40 29.34,23.70 27.19,24.58 26.89,26.89 24.58,27.19 23.70,29.34 21.40,29.03 19.99,30.88 17.84,29.98 16.00,31.40 14.16,29.98 12.01,30.88 10.60,29.03 8.30,29.34 7.42,27.19 5.11,26.89 4.81,24.58 2.66,23.70 2.97,21.40 1.12,19.99 2.02,17.84 0.60,16.00 2.02,14.16 1.12,12.01 2.97,10.60 2.66,8.30 4.81,7.42 5.11,5.11 7.42,4.81 8.30,2.66 10.60,2.97 12.01,1.12 14.16,2.02" fill="#0b4f4a" stroke="#0b4f4a" stroke-width=".8" stroke-linejoin="round"/><circle cx="16" cy="16" r="11.6" fill="none" stroke="#f6f3ec" stroke-width="1.2" stroke-opacity=".6"/><path d="M11.6 13.3h6.5a3.85 3.85 0 0 1 0 7.7h-5.1" fill="none" stroke="#f6f3ec" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/><path d="M14.6 10.3 11.6 13.3l3 3" fill="none" stroke="#f6f3ec" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/></svg><span class="wm">Recourse</span></a><span class="sb">PayPal sandbox</span></header>
<script>document.getElementById('back').addEventListener('click',function(){var r=document.referrer,same=false;try{same=r!==''&&new URL(r).origin===location.origin}catch(e){}if(same&&history.length>1){history.back()}else{location.href='/app/'}})</script>`;
const HEADER_CSS = `header{display:flex;align-items:center;gap:12px;max-width:640px;margin:0 auto;padding:16px 16px 0}
.back{all:unset;box-sizing:border-box;display:inline-flex;align-items:center;gap:4px;height:32px;padding:0 10px 0 6px;border:1px solid var(--line2);border-radius:4px;font:500 13.5px 'IBM Plex Sans',sans-serif;color:var(--ink2);cursor:pointer;background:var(--sheet)}
.back:hover{color:var(--ink);background:var(--soft)}.back:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.home{display:inline-flex;align-items:center;gap:10px;color:var(--ink);text-decoration:none}.home:hover{color:var(--accent)}.home:focus-visible{outline:2px solid var(--accent);outline-offset:3px;border-radius:2px}
header .wm{font:600 21px/1 'Fraunces',Georgia,serif;letter-spacing:-.01em}`;

function page(r: NonNullable<ReceiptView>, token: string, notice?: string): string {
  const st = STATUS[r.compliance as keyof typeof STATUS];
  const spec = r.spec as { category: string; max_total: { value: string; currency: string }; deadline: string };
  const lines = r.lines as Array<{ name: string; quantity: number; price: string; attributes: { size: string; unit_system: string | null; gender: string | null } }>;
  const when = r.captured_at ? new Date(r.captured_at).toUTCString() : '';
  const reported = r.cases.length > 0;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Purchase receipt</title>
<link rel="icon" type="image/svg+xml" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Cpolygon points='16.00,0.60 17.84,2.02 19.99,1.12 21.40,2.97 23.70,2.66 24.58,4.81 26.89,5.11 27.19,7.42 29.34,8.30 29.03,10.60 30.88,12.01 29.98,14.16 31.40,16.00 29.98,17.84 30.88,19.99 29.03,21.40 29.34,23.70 27.19,24.58 26.89,26.89 24.58,27.19 23.70,29.34 21.40,29.03 19.99,30.88 17.84,29.98 16.00,31.40 14.16,29.98 12.01,30.88 10.60,29.03 8.30,29.34 7.42,27.19 5.11,26.89 4.81,24.58 2.66,23.70 2.97,21.40 1.12,19.99 2.02,17.84 0.60,16.00 2.02,14.16 1.12,12.01 2.97,10.60 2.66,8.30 4.81,7.42 5.11,5.11 7.42,4.81 8.30,2.66 10.60,2.97 12.01,1.12 14.16,2.02' fill='%230b4f4a' stroke='%230b4f4a' stroke-width='.8' stroke-linejoin='round'/%3E%3Ccircle cx='16' cy='16' r='11.6' fill='none' stroke='%23f6f3ec' stroke-width='1.2' stroke-opacity='.6'/%3E%3Cpath d='M11.6 13.3h6.5a3.85 3.85 0 0 1 0 7.7h-5.1' fill='none' stroke='%23f6f3ec' stroke-width='2.5' stroke-linecap='round' stroke-linejoin='round'/%3E%3Cpath d='M14.6 10.3 11.6 13.3l3 3' fill='none' stroke='%23f6f3ec' stroke-width='2.5' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght,SOFT@9..144,500..600,50&family=IBM+Plex+Mono:wght@400;500&family=IBM+Plex+Sans:wght@400;500;600&display=swap" rel="stylesheet">
<style>
:root{--paper:#f6f3ec;--sheet:#fffdf8;--ink:#161a19;--ink2:#3d4542;--muted:#59615e;--line:#e2dccf;--line2:#c4bba8;--accent:#0b4f4a;--accent2:#083d39;--soft:#e2ece8;
--ok:#0d4d38;--okbg:#e4efe8;--warn:#8a3414;--warnbg:#fbefe6;--bad:#93260f;--badbg:#f7e2da;--signal:#a3361b}
*{box-sizing:border-box}body{margin:0;background:var(--paper);color:var(--ink);font:15px/1.5 'IBM Plex Sans',system-ui,-apple-system,'Segoe UI',sans-serif;font-variant-numeric:tabular-nums;-webkit-font-smoothing:antialiased}
${HEADER_CSS}
header .sb{margin-left:auto;display:inline-flex;align-items:center;gap:8px;font:500 11.5px 'IBM Plex Sans',sans-serif;color:var(--ink2);border:1px solid var(--line2);border-radius:99px;padding:2px 10px}
header .sb::before{content:'';width:7px;height:7px;border-radius:50%;background:var(--accent)}
main{max-width:640px;margin:0 auto;padding:16px 16px 48px}
h1{font:600 28px/1.2 'Fraunces',Georgia,serif;letter-spacing:-.015em;margin:8px 0 16px}
.sheet{background:var(--sheet);border:1px solid var(--line);border-radius:4px}
.sec{padding:16px 24px;border-top:1px solid var(--line)}.sec:first-child{border-top:0}
h2{font:600 12px/1.4 'IBM Plex Sans',sans-serif;text-transform:uppercase;letter-spacing:.08em;color:var(--ink2);margin:0 0 8px}
.badge{display:inline-flex;align-items:center;padding:0 7px;border-radius:2px;border:1px solid currentColor;font:600 12.5px/19px 'IBM Plex Sans',sans-serif;font-variant-caps:all-small-caps;letter-spacing:.08em}
.badge.ok{color:var(--ok);background:var(--okbg)}.badge.warn{color:var(--warn);background:var(--warnbg)}.badge.bad{color:var(--bad);background:var(--badbg)}
p{margin:8px 0 0}p:first-child{margin-top:0}p.ok{color:var(--ok)}p.warn,li.warn{color:var(--warn)}
.quote{font:500 18px/1.45 'Fraunces',Georgia,serif;border-left:2px solid var(--line2);padding-left:12px;margin:0}
ul{margin:0;padding-left:20px}li{margin:4px 0}.muted{color:var(--muted);font-size:13.5px}
a{color:var(--accent);text-underline-offset:2px}a:hover{color:var(--accent2)}
.amt{font-family:'IBM Plex Mono',monospace}
dl{display:grid;grid-template-columns:auto 1fr;gap:6px 16px;margin:0}dt{color:var(--muted)}dd{margin:0;word-break:break-all;font:13px/1.6 'IBM Plex Mono',monospace}
button{width:100%;font:500 15px 'IBM Plex Sans',sans-serif;height:44px;border-radius:4px;border:1px solid var(--accent);cursor:pointer;margin-top:8px}
.primary{background:var(--accent);color:#fff}.primary:hover{background:var(--accent2)}.secondary{background:var(--sheet);color:var(--accent);border-color:var(--line2)}.secondary:hover{background:var(--soft)}
:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
textarea{width:100%;font:inherit;padding:8px 10px;border-radius:4px;border:1px solid var(--line2);background:#fff;color:var(--ink);min-height:76px}
label{display:block;font-size:13px;font-weight:500;color:var(--ink2);margin:12px 0 8px}
.notice{border-left:2px solid var(--accent);padding:2px 0 2px 12px;margin:0 0 16px;color:var(--ink2)}
.outcome{border-left:3px solid var(--line2)}.outcome.ok{border-left-color:var(--ok)}.outcome p{margin:0 0 4px}
@media (max-width:440px){main{padding:8px 12px 32px}header{padding:12px 12px 0}.sec{padding:16px}h1{font-size:24px;margin-bottom:12px}
dl{grid-template-columns:1fr;gap:0}dt{margin-top:8px}dt:first-child{margin-top:0}.quote{font-size:17px}}
</style></head><body>
${HEADER}
<main>
<h1>Purchase receipt</h1>
${notice ? `<p class="notice" role="status">${esc(notice)}</p>` : ''}
<article class="sheet">
<section class="sec"><h2>Compliance</h2><span class="badge ${st.cls}">${esc(st.label)}</span><p class="muted">${esc(st.text)}</p></section>
<section class="sec"><h2>What you asked for</h2><p class="quote">${esc(r.source_text)}</p>
<p class="muted">Instructions v${esc(r.mandate_version)}: ${esc(spec.category)}, up to ${esc(spec.max_total.value)} ${esc(spec.max_total.currency)} in total, by ${esc(spec.deadline)}</p></section>
<section class="sec"><h2>What was bought</h2><ul>${lines
    .map((l) => `<li>${esc(l.quantity)} × ${esc(l.name)}, size ${esc(l.attributes.size)} ${l.attributes.unit_system ? esc(l.attributes.unit_system) : '(no size system given)'}${l.attributes.gender ? `, ${esc(l.attributes.gender)}'s` : ''}, ${esc(l.price)} ${esc(r.currency)}</li>`)
    .join('')}</ul><p>Total <strong class="amt">${esc(r.total)} ${esc(r.currency)}</strong> from ${esc(r.merchant_name)}</p></section>
<section class="sec"><h2>Differences</h2>${
    r.differences.length ? `<ul>${r.differences.map((d: string) => `<li class="warn">${esc(d)}</li>`).join('')}</ul>` : '<p class="ok">None found.</p>'
  }${r.matches.length ? `<p class="muted">Matches: ${esc(r.matches.join('; '))}</p>` : ''}</section>
<section class="sec"><h2>Payment</h2><dl><dt>PayPal transaction</dt><dd>${esc(r.paypal_capture_id)}</dd><dt>PayPal order</dt><dd>${esc(r.paypal_order_id)}</dd><dt>Reference</dt><dd>${esc(r.order_ref)}</dd><dt>Time</dt><dd>${esc(when)}</dd></dl></section>
<section class="sec">
${
  r.receipt_status === 'PENDING' && !reported
    ? `<form method="post" action="/r/${esc(token)}/confirm"><button class="primary" type="submit">Confirm purchase</button></form>`
    : r.receipt_status === 'CONFIRMED'
      ? `<p class="ok">You confirmed this purchase on ${esc(new Date(r.confirmed_at).toUTCString())}.</p>`
      : ''
}
${
  reported
    ? `${caseLine(r.cases[r.cases.length - 1])}<p class="muted"><a href="/app/console?page=case&amp;case=${esc(r.cases[r.cases.length - 1].id)}">View this case in the console</a></p>`
    : `<form method="post" action="/r/${esc(token)}/report"><label for="desc">What is wrong? (optional)</label><textarea id="desc" name="description"></textarea><button class="secondary" type="submit">Report an issue</button></form>`
}
<p class="muted">Confirming is not a waiver of your PayPal dispute rights.</p>
</section>
${outcome(r)}
</article>
</main></body></html>`;
}

function notFound(res: import('express').Response) {
  res
    .status(404)
    .type('html')
    .send(
      `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Receipt not found</title><style>:root{--ink:#161a19;--ink2:#3d4542;--line2:#c4bba8;--accent:#0b4f4a;--sheet:#fffdf8;--soft:#e2ece8}body{margin:0;background:#f6f3ec;color:var(--ink);font:15px/1.5 'IBM Plex Sans',system-ui,sans-serif}${HEADER_CSS}header .sb{margin-left:auto;font-size:11.5px;border:1px solid var(--line2);border-radius:99px;padding:2px 10px}main{max-width:640px;margin:0 auto;padding:24px 16px}</style></head><body>${HEADER}<main><p>This receipt link is not valid.</p></main></body></html>`,
    );
}

receipts.get(
  '/:token',
  route(async (req, res) => {
    const id = parseReceiptToken(req.params.token);
    const r = id ? await loadReceipt(id) : null;
    if (!r) return notFound(res);
    if (req.accepts(['html', 'json']) === 'json') return res.json(r);
    res.type('html').send(page(r, req.params.token));
  }),
);

receipts.post(
  '/:token/confirm',
  route(async (req, res) => {
    const id = parseReceiptToken(req.params.token);
    if (!id || !(await loadReceipt(id))) return notFound(res);
    const r = await confirmReceipt(id);
    if (req.accepts(['html', 'json']) === 'json') return res.json(r);
    res.type('html').send(page(r!, req.params.token, 'Thank you. Your confirmation is signed and recorded.'));
  }),
);

receipts.post(
  '/:token/report',
  route(async (req, res) => {
    const id = parseReceiptToken(req.params.token);
    if (!id || !(await loadReceipt(id))) return notFound(res);
    const description = typeof req.body?.description === 'string' ? req.body.description.trim() : '';
    const r = await reportIssue(id, description || 'Buyer reported an issue from the receipt.');
    if (req.accepts(['html', 'json']) === 'json') return res.json(r);
    res.type('html').send(page(r!, req.params.token, 'Your report is recorded and a case is open. No PayPal dispute was filed.'));
  }),
);
