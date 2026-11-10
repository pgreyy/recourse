import { useState } from 'react';
import { api, ErrorNote, Id, Modal, money, navigate, SettlementStatus, short, Status, useLoad, useLocation, Verdict, when, Who, maskEmail, plural } from '../lib';
import { Timeline, type Entry } from '../timeline';

type Detail = {
  case: any;
  mandate: any;
  order: any;
  timeline: Entry[];
  chain: { valid: boolean; entries: number; checkpoints: { count: number; all_signatures_valid: boolean } } | null;
  clauses: Array<{ id: string; text: string; code_status: string }>;
  code_checks: Array<{ id: string; status: string; detail: string }>;
  decision_facts: Array<{ fact: string; seqs: number[] }>;
  counterfactual: { note: string; snapshot_sha256: string | null; compliant_alternatives: any[] };
  injection_flags: Array<{ location: string; author: string; pattern: string; excerpt: string; note: string }>;
  settlement: any[];
  verification: { verified_at: string; from_cache: boolean };
};

const CHECK_TONE: Record<string, 'ok' | 'warn' | 'bad' | 'neutral'> = { PASS: 'ok', UNVERIFIABLE: 'warn', WARN: 'warn', FAIL: 'bad', NOT_APPLICABLE: 'neutral', SKIPPED: 'neutral' };
const checkLabel = (s: string) => ({ PASS: 'Pass', UNVERIFIABLE: 'Unverifiable', WARN: 'Warning', FAIL: 'Fail', NOT_APPLICABLE: 'N/A', SKIPPED: 'Skipped' } as Record<string, string>)[s] ?? s;

export function CaseDetail() {
  const { query } = useLocation();
  const list = useLoad((signal) => api<any[]>('/console/cases', { signal }), []);
  const id = query.get('case') ?? list.data?.find((c) => c.verdict === 'AGENT_FAULT')?.id ?? list.data?.[0]?.id ?? null;
  return (
    <div className="w">
      <ErrorNote error={list.error} />
      {id ? (
        <CaseBody
          key={id}
          id={id}
          proposal={query.get('proposal')}
          picker={
            <label className="row small muted" style={{ gap: 8 }}>
              Case
              <select value={id} onChange={(e) => navigate(`/console?page=case&case=${e.target.value}`)} style={{ maxWidth: 330 }}>
                {(list.data ?? []).map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.case_ref} ({c.source === 'PAYPAL_DISPUTE' ? 'dispute' : 'buyer report'}, {c.status.toLowerCase().replace(/_/g, ' ')})
                  </option>
                ))}
              </select>
            </label>
          }
        />
      ) : (
        !list.loading && <p className="muted">No cases yet.</p>
      )}
    </div>
  );
}

function CaseBody({ id, proposal, picker }: { id: string; proposal: string | null; picker: React.ReactNode }) {
  const d = useLoad((signal) => api<Detail>(`/console/cases/${id}`, { signal }), [id]);
  const [dialog, setDialog] = useState<null | 'approve' | 'accept'>(null);
  const [busy, setBusy] = useState(false);
  const [doing, setDoing] = useState('');
  const [err, setErr] = useState<Error | null>(null);

  if (d.error && !d.data) return <ErrorNote error={d.error} />;
  if (!d.data) return <p className="loading">Loading the case…</p>;
  const { case: c, mandate, order, timeline, clauses, code_checks, counterfactual, injection_flags, settlement, chain } = d.data;
  const a = c.latest_assessment;
  const ruling = c.ruling;
  const warn = timeline.find((e) => e.kind === 'checkout.firewall' && e.tone === 'warn' && (order ? e.seq < order.anchor_seq + 1 : true));
  const proceeded = timeline.find((e) => e.kind === 'checkout.started' && (e.payload as any)?.proceeded_despite_warnings);
  const runEnd = timeline.find((e) => e.kind === 'agent.run.finished' || e.kind === 'agent.run.failed')?.seq;

  const canApprove = Boolean(a && !ruling && a.verdict !== 'INCONCLUSIVE' && a.validation?.passed);
  const approveWhy = !a ? 'Not assessed yet' : ruling ? null : a.verdict === 'INCONCLUSIVE' ? 'Inconclusive: cannot become a ruling' : !a.validation?.passed ? 'Did not pass validation' : null;
  const operatorLiable = ruling?.liable_party === 'OPERATOR';
  const canAccept = Boolean(operatorLiable && ruling?.status === 'RULING_APPROVED' && !ruling.operator_accepted_at);

  async function run(fn: () => Promise<unknown>, what = '') {
    setBusy(true);
    setDoing(what);
    setErr(null);
    try {
      await fn();
      setDialog(null);
      d.reload();
    } catch (e) {
      setErr(e as Error);
    } finally {
      setBusy(false);
      setDoing('');
    }
  }
  const focusStep = (seq: number) => {
    if (runEnd && seq > runEnd) (document.getElementById('later-entries') as HTMLDetailsElement | null)?.setAttribute('open', '');
    const el = document.getElementById(`cstep-${seq}`);
    el?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    el?.focus();
  };

  return (
    <div className="stack" style={{ gap: 16 }}>
      {/* header */}
      <section className="card card-pad">
        <div className="case-head">
          <div style={{ minWidth: 0 }}>
            <div className="row" style={{ gap: 8 }}>
              <h1 className="mono" style={{ fontSize: 20, fontFamily: 'var(--mono)' }}>
                {c.case_ref}
              </h1>
              <Status tone={c.status === 'CLOSED' ? 'neutral' : 'accent'}>{c.status.replace(/_/g, ' ').toLowerCase()}</Status>
            </div>
            <p className="muted" style={{ marginTop: 4 }}>
              {c.source === 'PAYPAL_DISPUTE' ? `Opened by PayPal dispute ${c.dispute_id}` : 'Opened by the buyer from the receipt'} on {when(c.created_at)}. Order {order?.order_ref}, {money(order?.total)}
              {order?.receipt_path && (
                <>
                  {' '}
                  (<a href={order.receipt_path}>receipt</a>)
                </>
              )}
              .
            </p>
            {c.description && (
              <p style={{ marginTop: 6 }}>
                <span className="muted">Buyer said: </span>
                <q>{c.description}</q>
              </p>
            )}
          </div>
          <div className="case-actions">
            {picker}
            <div className="row" style={{ gap: 12, alignItems: 'flex-start' }}>
            {ruling ? (
              <span className="small muted" style={{ textAlign: 'right' }}>
                <Status tone="ok">Ruling approved</Status>
                <br />
                by {ruling.approved_by_name}, {when(ruling.approved_at)}
              </span>
            ) : (
              <>
                <button
                  className={`btn ${a ? 'secondary' : ''}`}
                  disabled={busy}
                  onClick={() => run(() => api(`/cases/${c.id}/assess`, { body: {} }), 'assess')}
                  title="Code checks, then the assessment model, then validation in code"
                >
                  {doing === 'assess' ? 'Assessing… (about 30 s)' : a ? 'Re-assess' : 'Assess'}
                </button>
                <button className="btn" disabled={!canApprove || busy} onClick={() => setDialog('approve')} title={approveWhy ?? undefined}>
                  Approve ruling
                </button>
              </>
            )}
            {operatorLiable &&
              (ruling.operator_accepted_at ? (
                <span className="small muted" style={{ textAlign: 'right' }}>
                  <Status tone="ok">Operator accepted</Status>
                  <br />
                  by {ruling.operator_accepted_by}, appeal waived
                </span>
              ) : (
                <button className="btn secondary" disabled={!canAccept || busy} onClick={() => setDialog('accept')}>
                  Operator accepts
                </button>
              ))}
            </div>
          </div>
        </div>
        {!ruling && approveWhy && <p className="small muted" style={{ marginTop: 8, textAlign: 'right' }}>{approveWhy}</p>}
        <p className="small muted row" style={{ marginTop: 10, gap: 10 }}>
          <span>Last verified against PayPal at {when(d.data.verification.verified_at)}</span>
          <button className="btn small secondary" disabled={busy} onClick={() => run(() => api(`/console/cases/${c.id}/verify`, { body: {} }), 'verify')}>
            {doing === 'verify' ? 'Verifying with PayPal…' : 'Re-verify now'}
          </button>
        </p>
        {proposal && (
          <div className="notice" role="status" style={{ marginTop: 12 }}>
            The Clerk proposed: <strong>{proposal.replace(/_/g, ' ')}</strong>. It cannot act. Review the evidence below; only the buttons above carry it out.
          </div>
        )}
        <ErrorNote error={err} />
      </section>

      {/* three columns */}
      <div className="case-cols">
        <section aria-labelledby="col-auth">
          <div className="col-title">
            <span className="n">1</span>
            <h2 id="col-auth">Authorised</h2>
          </div>
          <div className="card card-pad stack">
            {mandate ? (
              <>
                <div className="row" style={{ justifyContent: 'space-between' }}>
                  <strong>Signed mandate, version {mandate.version}</strong>
                  <span className="row" style={{ gap: 6 }}>
                    <Status tone={mandate.signature_valid ? 'ok' : 'bad'}>{mandate.signature_valid ? 'Signature valid' : 'Signature invalid'}</Status>
                    <Who by="code" />
                  </span>
                </div>
                <p className="quote" style={{ fontSize: 15 }}>
                  {mandate.source_text}
                </p>
                <div>
                  <h3 style={{ marginBottom: 2 }}>Clauses, checked at checkout</h3>
                  {clauses.map((cl) => (
                    <div className="clause" key={cl.id}>
                      <div>{cl.text}</div>
                      <div className="row" style={{ gap: 6 }}>
                        <span className="cid">{cl.id}</span>
                        <span className="spacer" />
                        <Status tone={CHECK_TONE[cl.code_status] ?? 'neutral'}>{checkLabel(cl.code_status)}</Status>
                        <Who by="code" />
                      </div>
                    </div>
                  ))}
                </div>
                <dl className="kv small">
                  <dt>Buyer</dt>
                  <dd>{maskEmail(mandate.buyer_email)}</dd>
                  <dt>Signed</dt>
                  <dd>{when(mandate.signed_at)}</dd>
                  <dt>Key</dt>
                  <dd className="mono">{mandate.signing_key_id}</dd>
                  <dt>Hash</dt>
                  <dd>
                    <Id title={mandate.mandate_hash}>{short(mandate.mandate_hash, 20)}</Id>
                  </dd>
                </dl>
              </>
            ) : (
              <p className="muted">No mandate linked.</p>
            )}
          </div>
        </section>

        <section aria-labelledby="col-what">
          <div className="col-title">
            <span className="n">2</span>
            <h2 id="col-what">What happened</h2>
          </div>
          <div className="card card-pad stack">
            {warn && proceeded && (
              <p className="callout">
                Warned at step {warn.seq}, proceeded at step {proceeded.seq}. <Who by="code" />
              </p>
            )}
            <Timeline compact entries={runEnd ? timeline.filter((e) => e.seq <= runEnd) : timeline} highlight={warn && proceeded ? [warn.seq, proceeded.seq] : []} idPrefix="cstep" />
            {runEnd && timeline.some((e) => e.seq > runEnd) && (
              <details open={false} id="later-entries">
                <summary className="small" style={{ cursor: 'pointer' }}>
                  After the purchase: {timeline.filter((e) => e.seq > runEnd).length} more entries (report, assessment, ruling, settlement)
                </summary>
                <div style={{ marginTop: 6 }}>
                  <Timeline compact entries={timeline.filter((e) => e.seq > runEnd)} idPrefix="cstep" />
                </div>
              </details>
            )}
            {chain && (
              <p className="small muted row" style={{ gap: 6 }}>
                <Status tone={chain.valid ? 'ok' : 'bad'}>{chain.valid ? 'Chain intact' : 'Chain broken'}</Status> {plural(chain.entries, 'entry', 'entries')}, {plural(chain.checkpoints.count, 'signed checkpoint')} <Who by="code" />
              </p>
            )}
            <Snapshot order={order} cf={counterfactual} />
          </div>
        </section>

        <section aria-labelledby="col-concl">
          <div className="col-title">
            <span className="n">3</span>
            <h2 id="col-concl">Conclusion</h2>
          </div>
          <div className="card card-pad stack">
            {!a ? (
              <p className="muted">Not assessed yet.</p>
            ) : (
              <>
                <div>
                  <div className="row" style={{ justifyContent: 'space-between' }}>
                    <span className="verdict">{(ruling?.verdict ?? a.verdict).replace(/_/g, ' ').toLowerCase().replace(/^\w/, (x: string) => x.toUpperCase())}</span>
                    <Verdict v={ruling?.verdict ?? a.verdict} />
                  </div>
                  <p className="small muted" style={{ marginTop: 4 }}>
                    {ruling ? `Ruling: liable party ${ruling.liable_party.toLowerCase().replace('_', ' ')}, ${money({ value: ruling.amount, currency: ruling.currency.trim() })}.` : 'Proposed by the assessment; not yet a ruling.'} Proposed by <Who by="ai" />, checked by <Who by="code" />, approved by a person.
                  </p>
                </div>
                <Block title="Violated clause" by="ai">
                  {a.violated_clauses.length ? (
                    a.violated_clauses.map((v: string) => (
                      <p key={v}>
                        {(clauses.find((cl) => cl.id === v)?.text ?? v).replace(/^\w/, (ch) => ch.toUpperCase())}
                      </p>
                    ))
                  ) : (
                    <p className="muted">None. No mandate clause was broken.</p>
                  )}
                </Block>
                <Block title="Cited steps" by="ai">
                  <div className="chips">
                    {a.cited_entries.map((s: number) => (
                      <button key={s} className="chip" onClick={() => focusStep(s)} aria-label={`Go to step ${s}`}>
                        step {s}
                      </button>
                    ))}
                  </div>
                </Block>
                <Block title="Counterfactual" by="code">
                  <p>{a.counterfactual?.note}</p>
                </Block>
                <Block title="Reasoning" by="ai">
                  <p>{a.reasoning}</p>
                </Block>
                <Block title={`Flagged in the evidence (${injection_flags.length})`} by="code">
                  {injection_flags.length === 0 && <p className="muted">Nothing instruction-like found.</p>}
                  {injection_flags.map((f, i) => (
                    <div className="flag" key={i}>
                      <div className="row small" style={{ justifyContent: 'space-between' }}>
                        <strong>Written by the {f.author}</strong>
                        <span className="muted mono">{f.location}</span>
                      </div>
                      <q>{f.excerpt}</q>
                      <div className="small muted">{f.note}</div>
                    </div>
                  ))}
                </Block>
                <Block title="Validation" by="code">
                  <p className="row" style={{ gap: 6 }}>
                    <Status tone={a.validation?.passed ? 'ok' : 'bad'}>{a.validation?.passed ? 'Passed' : 'Failed'}</Status>
                    <span className="small muted">the answer only cites real steps and clauses that code did not pass</span>
                  </p>
                  {a.human_review_reasons?.length > 0 && <p className="small muted">Human review required: {a.human_review_reasons.join('; ')}.</p>}
                  <p className="small muted">
                    Model {a.model}, prompt <span className="mono">{short(a.prompt_version_hash, 10)}</span>, evidence pack <span className="mono">{short(a.evidence_pack_hash, 10)}</span>
                  </p>
                </Block>
              </>
            )}
            <details>
              <summary className="small" style={{ cursor: 'pointer' }}>
                {code_checks.filter((x) => x.status === 'PASS').length} of {code_checks.length} evidence checks pass
              </summary>
              <ul className="checklist" style={{ marginTop: 6 }}>
                {code_checks.map((x) => (
                  <li key={x.id}>
                    <Status tone={CHECK_TONE[x.status] ?? 'neutral'}>{checkLabel(x.status)}</Status>
                    <span>
                      <span className="mono small">{x.id}</span> {x.detail}
                    </span>
                    <Who by="code" />
                  </li>
                ))}
              </ul>
            </details>
          </div>
        </section>
      </div>

      <SettlementPanel obligations={settlement} busy={busy} act={(path) => run(() => api(path, { body: {} }), 'settle')} />

      {dialog === 'approve' && (
        <PersonDialog
          title="Approve ruling"
          text={`Approving signs a ruling of ${(a?.verdict ?? '').replace(/_/g, ' ').toLowerCase()} for ${c.case_ref}. It moves no money by itself.`}
          withEmail
          busy={busy}
          error={err}
          onClose={() => setDialog(null)}
          onConfirm={(name, email) => run(() => api(`/cases/${c.id}/approve`, { body: { approved_by: { name, email }, assessment_id: a?.id } }))}
        />
      )}
      {dialog === 'accept' && (
        <PersonDialog
          title="Operator accepts the ruling"
          text="The operator accepts the ruling and waives the appeal window. Recovery from the operator can then run, within the agreed caps."
          busy={busy}
          error={err}
          onClose={() => setDialog(null)}
          onConfirm={(name) => run(() => api(`/rulings/${ruling.id}/operator-accept`, { body: { accepted_by: name } }))}
        />
      )}
    </div>
  );
}

function Block({ title, by, children }: { title: string; by: 'ai' | 'code'; children: React.ReactNode }) {
  return (
    <div className="stack" style={{ gap: 4 }}>
      <h3 className="row" style={{ gap: 6 }}>
        {title} <Who by={by} />
      </h3>
      {children}
    </div>
  );
}

function Snapshot({ order, cf }: { order: any; cf: Detail['counterfactual'] }) {
  const bought = order?.lines?.[0];
  const alt = cf?.compliant_alternatives?.[0];
  if (!bought) return null;
  const size = (x: any) => `${x.attributes.gender ? `${x.attributes.gender}'s ` : ''}${x.attributes.unit_system ? `${x.attributes.unit_system} ${x.attributes.size}` : `${x.attributes.size} (no size system given)`}`;
  return (
    <div className="stack" style={{ gap: 6 }}>
      <h3 className="row" style={{ gap: 6 }}>
        Frozen catalog snapshot <Who by="code" />
      </h3>
      <div className="snap">
        <div>
          <div className="small muted">Bought</div>
          <strong>{bought.name}</strong>
          <div className="small">
            Size {size(bought)}, {bought.price}
          </div>
          <div className="small muted mono">{bought.variant_id}</div>
        </div>
        {alt ? (
          <div className="alt">
            <div className="small" style={{ color: 'var(--ok-ink)' }}>
              Compliant alternative, in stock
            </div>
            <strong>{alt.name}</strong>
            <div className="small">
              Size {size(alt)}, {alt.price}, {alt.stock} in stock
            </div>
            <div className="small muted mono">{alt.variant_id}</div>
          </div>
        ) : (
          <div>
            <div className="small muted">Compliant alternative</div>
            <p className="small">None existed at the decision step.</p>
          </div>
        )}
      </div>
      {cf?.snapshot_sha256 && (
        <p className="small muted">
          Snapshot sha256 <span className="mono">{short(cf.snapshot_sha256, 16)}</span>, taken when the agent decided
        </p>
      )}
    </div>
  );
}

const ACTION_LABEL: Record<string, string> = {
  REFUND_BUYER: 'Refund the buyer',
  CHARGE_OPERATOR: 'Charge the operator',
  INVOICE_OPERATOR: 'Invoice the operator',
  REFUND_OPERATOR: 'Refund the operator (reversal)',
  DISPUTE_ACCEPT_CLAIM: 'Accept the PayPal claim',
  DISPUTE_MAKE_OFFER: 'Offer a refund in the dispute',
  DISPUTE_ESCALATE: 'Escalate the dispute',
  DISPUTE_PROVIDE_EVIDENCE: 'File evidence with PayPal',
};
/** PayPal codes as words: UNDER_REVIEW is "under review". */
const codeWords = (x: unknown) => String(x ?? '').toLowerCase().replace(/_/g, ' ');
const KIND_LABEL: Record<string, string> = { RECOVERY: 'Recovery', DISPUTE_RESPONSE: 'PayPal dispute response', NO_CHARGE: 'No charge', REVERSAL: 'Reversal' };

function SettlementPanel({ obligations, busy, act }: { obligations: any[]; busy: boolean; act: (path: string) => void }) {
  return (
    <section className="card" aria-labelledby="settle-title">
      <div className="card-head">
        <h2 id="settle-title">Settlement</h2>
        <span className="small muted">Every action with its PayPal id. Recovered only once PayPal confirms.</span>
      </div>
      <div className="card-pad stack">
        {obligations.length === 0 && <p className="muted">No settlement yet. A settlement starts when a ruling is approved.</p>}
        {obligations.map((o) => (
          <div key={o.id} className="stack" style={{ gap: 10 }}>
            <div className="row" style={{ justifyContent: 'space-between' }}>
              <div className="row">
                <strong>{KIND_LABEL[o.kind] ?? o.kind}</strong>
                <span className="small muted">
                  workflow {o.workflow}, {(o.verdict ?? '').replace(/_/g, ' ').toLowerCase()}, {money(o.amount)}
                </span>
              </div>
              <div className="row">
                <SettlementStatus s={o.status} />
                {o.status === 'RECOVERED' && <span className="small">{money(o.recovered)} recovered</span>}
                {!['RECOVERED', 'COMPLETED', 'NO_ACTION'].includes(o.status) && (
                  <button className="btn small" disabled={busy} onClick={() => act(`/settlements/${o.id}/execute`)} title="Runs the pre-checks, then the next PayPal action. Safe to repeat.">
                    Run settlement
                  </button>
                )}
                {o.actions.some((x: any) => x.status === 'SUCCEEDED' && x.confirmation !== 'confirmed') && (
                  <button className="btn small secondary" disabled={busy} onClick={() => act(`/settlements/${o.id}/reconcile`)} title="Ask PayPal now instead of waiting for the webhook">
                    Check with PayPal
                  </button>
                )}
              </div>
            </div>
            <table className="plain" aria-label="PayPal actions">
              <thead>
                <tr>
                  <th>Action</th>
                  <th>PayPal ids</th>
                  <th className="num">Amount</th>
                  <th>PayPal says</th>
                  <th>When</th>
                </tr>
              </thead>
              <tbody>
                {o.actions.map((x: any) => (
                  <tr key={x.idempotency_key}>
                    <td>
                      {ACTION_LABEL[x.action] ?? x.action}
                      <div className="small muted">
                        HTTP {x.http_status ?? '—'}
                        {x.debug_id ? `, debug ${x.debug_id}` : ''}
                      </div>
                    </td>
                    <td>
                      <div className="stack" style={{ gap: 3 }}>
                        {Object.entries(x.paypal_ids ?? {}).map(([k, v]) => (
                          <span key={k} className="small">
                            <span className="muted">{k.replace(/_/g, ' ')}</span> <Id>{String(v)}</Id>
                          </span>
                        ))}
                      </div>
                    </td>
                    <td className="num nowrap">{x.amount ? money(x.amount) : '—'}</td>
                    <td>
                      {x.status === 'FAILED' ? (
                        <Status tone="bad">Failed</Status>
                      ) : x.confirmation === 'confirmed' ? (
                        <Status tone="ok">Confirmed</Status>
                      ) : (
                        <Status tone="warn">Pending</Status>
                      )}
                      {x.confirmed_by && <div className="small muted">by {x.confirmed_by}</div>}
                    </td>
                    <td className="small nowrap">{when(x.confirmed_at ?? x.completed_at ?? x.created_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {o.paypal_dispute && (
              <p className="small">
                PayPal dispute now: <strong>{codeWords(o.paypal_dispute.status)}</strong>
                {o.paypal_dispute.stage ? ` (${codeWords(o.paypal_dispute.stage)} stage)` : ''}
                {o.paypal_dispute.outcome ? `, outcome: ${codeWords(o.paypal_dispute.outcome.outcome_code ?? JSON.stringify(o.paypal_dispute.outcome))}` : ', no outcome yet'}. Read from PayPal.
              </p>
            )}
            <details>
              <summary className="small" style={{ cursor: 'pointer' }}>
                Pre-checks before acting ({o.checks?.filter((k: any) => k.ok).length ?? 0} of {o.checks?.length ?? 0} passed)
              </summary>
              <ul className="checklist" style={{ marginTop: 6 }}>
                {(o.checks ?? []).map((k: any) => (
                  <li key={k.id}>
                    <Status tone={k.ok ? 'ok' : 'bad'}>{k.ok ? 'Pass' : 'Fail'}</Status>
                    <span>
                      <span className="mono small">{k.id}</span> {k.detail}
                    </span>
                    <Who by="code" />
                  </li>
                ))}
              </ul>
            </details>
          </div>
        ))}
      </div>
    </section>
  );
}

function PersonDialog(p: { title: string; text: string; withEmail?: boolean; busy: boolean; error: Error | null; onClose: () => void; onConfirm: (name: string, email: string) => void }) {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  return (
    <Modal title={p.title} onClose={p.onClose}>
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          p.onConfirm(name, email);
        }}
      >
        <p className="muted">{p.text}</p>
        <label className="field">
          Your name
          <input value={name} onChange={(e) => setName(e.target.value)} required />
        </label>
        {p.withEmail && (
          <label className="field">
            Email
            <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
          </label>
        )}
        <ErrorNote error={p.error} />
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button type="button" className="btn secondary" onClick={p.onClose}>
            Cancel
          </button>
          <button className="btn" disabled={p.busy}>
            {p.busy ? 'Working…' : 'Confirm'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
