import { Router } from 'express';
import { route } from '../shared/http/errors';
import { confirmReceipt, loadReceipt, parseReceiptToken, reportIssue, type ReceiptView } from './receipts';

export const receipts = Router();

const esc = (s: unknown) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

const STATUS = {
  COMPLIANT: { label: 'Compliant', cls: 'ok', text: 'Everything checked matches your mandate.' },
  WARNING: { label: 'Warning', cls: 'warn', text: 'Bought within your mandate, but some details could not be verified.' },
  VIOLATION_APPROVED: { label: 'Violation (you approved it)', cls: 'bad', text: 'This purchase broke a mandate rule and went ahead only after you approved it at PayPal.' },
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
    return `<div class="card outcome ok" role="status"><h2>Outcome</h2><p><strong>Resolved: refunded ${esc(f.value)} ${esc(f.currency.trim())} on ${esc(day(f.confirmed_at ?? f.completed_at!))}.</strong></p><p class="muted">Confirmed by PayPal${f.refund_id ? `, refund ${esc(f.refund_id)}` : ''}.${ru?.verdict === 'AGENT_FAULT' ? " The agent's operator covers the cost." : ''} You do not need to file a dispute.</p></div>`;
  }
  if (f) {
    return `<div class="card outcome" role="status"><h2>Outcome</h2><p><strong>Refund of ${esc(f.value)} ${esc(f.currency.trim())} issued on ${esc(day(f.completed_at!))}.</strong></p><p class="muted">Waiting for PayPal to confirm it.</p></div>`;
  }
  if (!ru) return '';
  const v = VERDICT_WORDS[ru.verdict] ?? ru.verdict.toLowerCase().replace(/_/g, ' ');
  if (ru.case_status === 'CLOSED') {
    return `<div class="card outcome" role="status"><h2>Outcome</h2><p><strong>Resolved on ${esc(day(ru.approved_at))}: no refund.</strong></p><p class="muted">The ruling found ${esc(v)}.</p></div>`;
  }
  const where = ru.source === 'PAYPAL_DISPUTE' ? ' Your PayPal dispute is still under review at PayPal, which makes the final decision.' : '';
  return `<div class="card outcome" role="status"><h2>Outcome</h2><p><strong>Ruling on ${esc(day(ru.approved_at))}: ${esc(v)}.</strong></p><p class="muted">Not resolved yet.${where}</p></div>`;
}

const CASE_STATUS: Record<string, string> = { OPEN: 'open', ASSESSED: 'being reviewed', RULING_APPROVED: 'decided', APPEALED: 'under appeal', CLOSED: 'closed' };
function caseLine(c: { case_ref: string; status: string; source?: string }): string {
  const how = c.source === 'PAYPAL_DISPUTE' ? 'You opened a PayPal dispute' : 'You reported an issue';
  return `<p class="warn">${how}. Case ${esc(c.case_ref)} is ${esc(CASE_STATUS[c.status] ?? c.status.toLowerCase().replace(/_/g, ' '))}.</p>`;
}

function page(r: NonNullable<ReceiptView>, token: string, notice?: string): string {
  const st = STATUS[r.compliance as keyof typeof STATUS];
  const spec = r.spec as { category: string; max_total: { value: string; currency: string }; deadline: string };
  const lines = r.lines as Array<{ name: string; quantity: number; price: string; attributes: { size: string; unit_system: string | null; gender: string | null } }>;
  const when = r.captured_at ? new Date(r.captured_at).toUTCString() : '';
  const reported = r.cases.length > 0;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Purchase receipt</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400&family=IBM+Plex+Sans:wght@400;500;600&family=IBM+Plex+Serif:wght@600&display=swap" rel="stylesheet">
<style>
:root{--paper:#f5f4f0;--card:#fff;--ink:#14201f;--ink2:#44514f;--muted:#5f6b68;--line:#e0ddd5;--line2:#c7c2b6;--accent:#0b4f4a;--accent2:#083d39;--soft:#e2edeb;
--ok:#1a5c35;--okbg:#e3f0e7;--okl:#9cc7aa;--warn:#6f4500;--warnbg:#fbf0d6;--warnl:#e1bf72;--bad:#94231a;--badbg:#f8e4e0;--badl:#df9f95}
*{box-sizing:border-box}body{margin:0;background:var(--paper);color:var(--ink);font:15px/1.5 'IBM Plex Sans',system-ui,-apple-system,'Segoe UI',sans-serif;-webkit-font-smoothing:antialiased}
header{background:var(--ink);color:#fff;height:52px;display:flex;align-items:center;gap:10px;padding:0 16px;font:600 16px 'IBM Plex Serif',Georgia,serif}
header svg{width:22px;height:22px}header .sb{margin-left:auto;font:400 12px 'IBM Plex Sans',sans-serif;color:#d6dcdb;border:1px solid #4d5c5a;border-radius:99px;padding:2px 8px}
main{max-width:600px;margin:0 auto;padding:20px 16px 40px}
.card{background:var(--card);border:1px solid var(--line);border-radius:6px;padding:16px 18px;margin:0 0 12px}
h1{font:600 24px/1.25 'IBM Plex Serif',Georgia,serif;margin:4px 0 16px}
h2{font-size:12.5px;font-weight:600;text-transform:uppercase;letter-spacing:.06em;color:var(--ink2);margin:0 0 8px}
.badge{display:inline-flex;align-items:center;gap:6px;font:600 12px/20px 'IBM Plex Sans',sans-serif;letter-spacing:.03em;text-transform:uppercase;padding:1px 9px;border-radius:4px;border:1px solid}
.badge::before{content:'';width:7px;height:7px;border-radius:50%;background:currentColor}
.badge.ok{color:var(--ok);background:var(--okbg);border-color:var(--okl)}.badge.warn{color:var(--warn);background:var(--warnbg);border-color:var(--warnl)}.badge.bad{color:var(--bad);background:var(--badbg);border-color:var(--badl)}
p.ok{color:var(--ok)}p.warn,li.warn{color:var(--warn)}
.quote{font:600 17px/1.5 'IBM Plex Serif',Georgia,serif;border-left:3px solid var(--line2);padding-left:12px;margin:0 0 8px}
ul{margin:0;padding-left:20px}li{margin:4px 0}.muted{color:var(--muted);font-size:13.5px}
dl{display:grid;grid-template-columns:auto 1fr;gap:6px 14px;margin:0}dt{color:var(--muted)}dd{margin:0;word-break:break-all;font:13px/1.6 'IBM Plex Mono',monospace}
button{width:100%;font:500 15px 'IBM Plex Sans',sans-serif;height:44px;border-radius:6px;border:1px solid var(--accent);cursor:pointer;margin-top:8px}
.primary{background:var(--accent);color:#fff}.primary:hover{background:var(--accent2)}.secondary{background:#fff;color:var(--accent);border-color:var(--line2)}.secondary:hover{background:var(--soft)}
:focus-visible{outline:2px solid var(--ink);outline-offset:2px}
textarea{width:100%;font:inherit;padding:8px 10px;border-radius:6px;border:1px solid var(--line2);background:#fff;color:var(--ink);min-height:76px}
textarea:focus-visible{outline:2px solid var(--accent);outline-offset:0}
label{display:block;font-size:13px;font-weight:500;color:var(--ink2);margin:12px 0 6px}
.notice{border-left:3px solid var(--accent)}
.card>p:first-child,.card>form:first-child{margin-top:0}.card>p:last-child{margin-bottom:0}
.outcome{border-left:3px solid var(--line2)}.outcome.ok{border-left-color:var(--ok)}.outcome p{margin:0 0 4px}
@media (max-width:440px){main{padding:16px 12px 32px}.card{padding:14px}h1{font-size:22px;margin-bottom:12px}
dl{grid-template-columns:1fr;gap:0}dt{margin-top:8px}dt:first-child{margin-top:0}.quote{font-size:16px}header .sb{font-size:11px}}
</style></head><body>
<header><svg viewBox="0 0 32 32" aria-hidden="true"><rect width="32" height="32" rx="6" fill="#0b4f4a"/><path d="M10 23V9h7a4.5 4.5 0 0 1 0 9h-7m7 0 5 5" stroke="#fff" stroke-width="2.6" fill="none"/></svg>Recourse<span class="sb">PayPal sandbox</span></header>
<main>
<h1>Purchase receipt</h1>
${notice ? `<div class="card notice" role="status">${esc(notice)}</div>` : ''}
<div class="card"><h2>Compliance</h2><span class="badge ${st.cls}">${esc(st.label)}</span><p class="muted">${esc(st.text)}</p></div>
<div class="card"><h2>What you asked for</h2><p class="quote">${esc(r.source_text)}</p>
<p class="muted">Mandate v${esc(r.mandate_version)}: ${esc(spec.category)}, up to ${esc(spec.max_total.value)} ${esc(spec.max_total.currency)} in total, by ${esc(spec.deadline)}</p></div>
<div class="card"><h2>What was bought</h2><ul>${lines
    .map((l) => `<li>${esc(l.quantity)} × ${esc(l.name)}, size ${esc(l.attributes.size)} ${l.attributes.unit_system ? esc(l.attributes.unit_system) : '(no size system given)'}${l.attributes.gender ? `, ${esc(l.attributes.gender)}'s` : ''}, ${esc(l.price)} ${esc(r.currency)}</li>`)
    .join('')}</ul><p>Total <strong>${esc(r.total)} ${esc(r.currency)}</strong> from ${esc(r.merchant_name)}</p></div>
<div class="card"><h2>Differences</h2>${
    r.differences.length ? `<ul>${r.differences.map((d: string) => `<li class="warn">${esc(d)}</li>`).join('')}</ul>` : '<p class="ok">None found.</p>'
  }${r.matches.length ? `<p class="muted">Matches: ${esc(r.matches.join('; '))}</p>` : ''}</div>
<div class="card"><h2>Payment</h2><dl><dt>PayPal transaction</dt><dd>${esc(r.paypal_capture_id)}</dd><dt>PayPal order</dt><dd>${esc(r.paypal_order_id)}</dd><dt>Reference</dt><dd>${esc(r.order_ref)}</dd><dt>Time</dt><dd>${esc(when)}</dd></dl></div>
<div class="card">
${
  r.receipt_status === 'PENDING' && !reported
    ? `<form method="post" action="/r/${esc(token)}/confirm"><button class="primary" type="submit">Confirm purchase</button></form>`
    : r.receipt_status === 'CONFIRMED'
      ? `<p class="ok">You confirmed this purchase on ${esc(new Date(r.confirmed_at).toUTCString())}.</p>`
      : ''
}
${
  reported
    ? caseLine(r.cases[r.cases.length - 1])
    : `<form method="post" action="/r/${esc(token)}/report"><label for="desc">What is wrong? (optional)</label><textarea id="desc" name="description"></textarea><button class="secondary" type="submit">Report an issue</button></form>`
}
<p class="muted">Confirming is not a waiver of your PayPal dispute rights.</p>
</div>
${outcome(r)}
</main></body></html>`;
}

function notFound(res: import('express').Response) {
  res.status(404).type('html').send('<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><p style="font:16px system-ui;padding:16px">This receipt link is not valid.</p>');
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
