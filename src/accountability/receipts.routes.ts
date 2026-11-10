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

function page(r: NonNullable<ReceiptView>, token: string, notice?: string): string {
  const st = STATUS[r.compliance as keyof typeof STATUS];
  const spec = r.spec as { category: string; max_total: { value: string; currency: string }; deadline: string };
  const lines = r.lines as Array<{ name: string; quantity: number; price: string; attributes: { size: string; unit_system: string | null; gender: string | null } }>;
  const when = r.captured_at ? new Date(r.captured_at).toUTCString() : '';
  const reported = r.cases.length > 0;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Purchase receipt</title>
<style>
:root{--bg:#f6f7f9;--card:#fff;--ink:#1b1f24;--muted:#5b6470;--line:#e3e6ea;--ok:#13795b;--warn:#a15c00;--bad:#b42318;--btn:#1b1f24}
@media (prefers-color-scheme:dark){:root{--bg:#111418;--card:#1a1e24;--ink:#eef1f4;--muted:#a3abb5;--line:#2b3138;--ok:#4cc79a;--warn:#f0a542;--bad:#ff7a6e;--btn:#eef1f4}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.45 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
main{max-width:560px;margin:0 auto;padding:16px}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:16px;margin:0 0 12px}
h1{font-size:20px;margin:4px 0 12px}h2{font-size:13px;text-transform:uppercase;letter-spacing:.04em;color:var(--muted);margin:0 0 8px}
.badge{display:inline-block;font-weight:600;padding:2px 10px;border-radius:999px;border:1px solid currentColor}
.ok{color:var(--ok)}.warn{color:var(--warn)}.bad{color:var(--bad)}
ul{margin:0;padding-left:20px}li{margin:4px 0}.muted{color:var(--muted);font-size:14px}
dl{display:grid;grid-template-columns:auto 1fr;gap:4px 12px;margin:0}dt{color:var(--muted)}dd{margin:0;word-break:break-all}
button{width:100%;font:inherit;font-weight:600;padding:12px;border-radius:10px;border:1px solid var(--btn);cursor:pointer;margin-top:8px}
.primary{background:var(--btn);color:var(--bg)}.secondary{background:transparent;color:var(--ink)}
textarea{width:100%;font:inherit;padding:8px;border-radius:8px;border:1px solid var(--line);background:var(--card);color:var(--ink);min-height:70px}
.notice{border-left:4px solid var(--ok)}
</style></head><body><main>
<h1>Purchase receipt</h1>
${notice ? `<div class="card notice">${esc(notice)}</div>` : ''}
<div class="card"><h2>Compliance</h2><span class="badge ${st.cls}">${esc(st.label)}</span><p class="muted">${esc(st.text)}</p></div>
<div class="card"><h2>What you asked for</h2><p>${esc(r.source_text)}</p>
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
    ? `<p class="warn">You reported an issue. Case ${esc(r.cases[r.cases.length - 1].id)} is ${esc(r.cases[r.cases.length - 1].status)}.</p>`
    : `<form method="post" action="/r/${esc(token)}/report"><textarea name="description" placeholder="What is wrong? (optional)"></textarea><button class="secondary" type="submit">Report an issue</button></form>`
}
<p class="muted">Confirming is not a waiver of your PayPal dispute rights.</p>
</div>
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
