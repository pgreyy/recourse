import { useState } from 'react';
import { api, BackButton, ErrorNote, Modal, money, navigate, Status, useLoad, useLocation, Verdict, when, Who } from '../lib';
import { PersonDialog } from '../console/CaseDetail';
import { WhoPaid } from '../console/WhoPaid';

/**
 * The operator's view of a decision: what it is asked to accept or appeal, the evidence it rests on, the money, and
 * what is left of its cap. Accept and Appeal use the same endpoints as the console; an appeal note goes through the
 * injection guard on the server.
 */
export function OperatorDecision() {
  const { query } = useLocation();
  const id = query.get('case') ?? '';
  const [reload, setReload] = useState(0);
  const d = useLoad((signal) => api<any>(`/console/cases/${id}`, { signal }), [id, reload]);
  const v = useLoad((signal) => api<any>(`/console/cases/${id}/operator-view`, { signal }), [id, reload]);
  const [dialog, setDialog] = useState<null | 'accept' | 'appeal'>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<Error | null>(null);
  const [note, setNote] = useState('');
  const [flag, setFlag] = useState<string | null>(null);

  if (!id) return <main className="page"><p className="muted">No case selected.</p></main>;
  if ((d.error || v.error) && !d.data) return <main className="page"><ErrorNote error={d.error ?? v.error} /></main>;
  if (!d.data || !v.data) return <main className="page"><p className="loading">Loading the decision…</p></main>;
  const c = d.data.case;
  const ruling = c.ruling;
  const a = c.latest_assessment;
  const settled = (d.data.settlement ?? []).find((o: any) => o.who_paid)?.who_paid;
  const ag = v.data.agreement;
  const pv = v.data.preview;
  const appeal = v.data.appeal;
  const deadlinePassed = ruling?.appeal_deadline ? new Date(ruling.appeal_deadline).getTime() < Date.now() : false;
  const decided = Boolean(ruling?.operator_accepted_at) || Boolean(appeal);
  const liable = ruling?.liable_party === 'OPERATOR';
  const run = async (fn: () => Promise<any>) => {
    setBusy(true);
    setErr(null);
    try {
      const r = await fn();
      if (r?.flag) setFlag(r.flag.note);
      setDialog(null);
      setReload((n) => n + 1);
    } catch (e) {
      setErr(e as Error);
    } finally {
      setBusy(false);
    }
  };
  const timeline: Array<{ seq: number; title: string; detail: string; sub?: boolean }> = d.data.timeline ?? [];
  const cited = (a?.cited_entries ?? []).map((s: number) => timeline.find((t) => t.seq === s && !t.sub)).filter(Boolean);
  const clauses: Array<{ id: string; text: string }> = d.data.clauses ?? [];

  return (
    <main className="page" style={{ maxWidth: 1040 }}>
      <div className="page-head">
        <div>
          <BackButton />
          <h1>Decision for {v.data.operator?.name ?? 'the operator'}</h1>
          <p>What the operator is asked to accept or appeal, the evidence it rests on, and the money, within the caps it signed.</p>
        </div>
      </div>

      <div className="stack" style={{ gap: 24 }}>
        <section className="card card-pad stack" aria-labelledby="dec-title">
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <h2 id="dec-title" className="mono" style={{ fontSize: 17 }}>
              {c.case_ref}
            </h2>
            <Verdict v={ruling?.verdict ?? a?.verdict} />
          </div>
          {ruling ? (
            <p>
              Decision approved by {ruling.approved_by_name}, {when(ruling.approved_at)}. Liable party: <strong>{String(ruling.liable_party).toLowerCase()}</strong>, {money({ value: ruling.amount, currency: ruling.currency.trim() })}.{' '}
              {ruling.appeal_deadline && <>Appeal window {deadlinePassed ? 'closed' : 'open until'} {when(ruling.appeal_deadline)}.</>}
            </p>
          ) : (
            <p className="muted">Not decided yet: there is nothing to accept or appeal.</p>
          )}
          <div className="row">
            {ruling?.operator_accepted_at && <Status tone="ok">Accepted by {ruling.operator_accepted_by}</Status>}
            {appeal && <Status tone={appeal.status === 'OPEN' ? 'warn' : 'neutral'}>{`Appeal ${String(appeal.status).toLowerCase()}`}</Status>}
          </div>
          {ruling && liable && !decided && (
            <div className="row">
              <button className="btn" disabled={busy || deadlinePassed} onClick={() => setDialog('accept')}>
                Accept
              </button>
              <button className="btn secondary" disabled={busy || deadlinePassed} onClick={() => setDialog('appeal')}>
                Appeal
              </button>
              <span className="small muted">Accepting waives the appeal window; recovery can then run within the caps.</span>
            </div>
          )}
          {flag && <p className="notice warn">The appeal note contains instruction-like text. It is recorded as evidence and flagged; it is never followed.</p>}
          <ErrorNote error={err} />
        </section>

        <div className="grid2" style={{ alignItems: 'start' }}>
          <section className="card card-pad stack" aria-labelledby="ev-title">
            <h2 id="ev-title">The evidence it rests on</h2>
            {(a?.violated_clauses ?? []).length > 0 && (
              <div className="stack" style={{ gap: 4 }}>
                <h3 className="row" style={{ gap: 6 }}>
                  Clause broken <Who by="ai" />
                </h3>
                {a.violated_clauses.map((cid: string) => (
                  <p key={cid}>{(clauses.find((x) => x.id === cid)?.text ?? cid).replace(/^\w/, (ch: string) => ch.toUpperCase())}</p>
                ))}
              </div>
            )}
            {cited.length > 0 && (
              <div className="stack" style={{ gap: 4 }}>
                <h3 className="row" style={{ gap: 6 }}>
                  Cited steps <Who by="ai" />
                </h3>
                <ul className="why-not">
                  {cited.map((t: any) => (
                    <li key={t.seq}>
                      <span className="mono small">step {t.seq}</span> {t.title}
                      {t.detail ? <span className="small muted">: {t.detail}</span> : null}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {a?.counterfactual?.note && (
              <div className="stack" style={{ gap: 4 }}>
                <h3 className="row" style={{ gap: 6 }}>
                  What it could have chosen <Who by="code" />
                </h3>
                <p>{a.counterfactual.note.replace(/^\w/, (ch: string) => ch.toUpperCase())}</p>
              </div>
            )}
            {(d.data.why_not ?? []).length > 0 && (
              <div className="stack" style={{ gap: 4 }}>
                <h3>Why not the others</h3>
                <ul className="why-not">
                  {d.data.why_not
                    .filter((w: any) => w.verdict !== (ruling?.verdict ?? a?.verdict))
                    .map((w: any) => (
                      <li key={w.verdict}>
                        <span>{w.text}</span> <Who by={w.source} />
                      </li>
                    ))}
                </ul>
              </div>
            )}
          </section>

          <section className="card card-pad stack" aria-labelledby="money-title">
            <h2 id="money-title">The money</h2>
            {settled ? (
              <WhoPaid w={settled} />
            ) : (
              <div className="stack" style={{ gap: 6 }}>
                <h3 className="row" style={{ gap: 6 }}>
                  Who would pay what <Who by="code" />
                </h3>
                <p>
                  Buyer refunded <strong className="mono">{pv.buyer_refund} {pv.currency}</strong>.
                </p>
                <p>
                  {v.data.operator?.name ?? 'The operator'} charged <strong className="mono">{pv.operator_charge_from} {pv.currency}</strong> plus the PayPal fees on the refund and on this charge, so the merchant nets 0.00
                  {pv.operator_charge_limit ? `, never more than ${pv.operator_charge_limit} ${pv.currency}` : ''}.
                </p>
                <p className="small muted">Exact figures appear here once PayPal confirms the refund and the charge.</p>
              </div>
            )}
            {ag ? (
              <dl className="kv">
                <dt>Agreement</dt>
                <dd>v{ag.version}</dd>
                <dt>Per incident</dt>
                <dd className="mono">{ag.per_incident_cap} {ag.currency}</dd>
                <dt>Total cap</dt>
                <dd className="mono">{ag.aggregate_cap} {ag.currency}</dd>
                <dt>Cap remaining</dt>
                <dd className="mono">{ag.cap_remaining} {ag.currency}</dd>
                <dt>Appeal window</dt>
                <dd>{ag.appeal_window_hours} hours</dd>
              </dl>
            ) : (
              <p className="muted">This operator has no accepted agreement.</p>
            )}
            <p>
              <a
                href={`/app/console?page=case&case=${c.id}`}
                onClick={(e) => {
                  e.preventDefault();
                  navigate(`/console?page=case&case=${c.id}`);
                }}
              >
                Open the full case in the console
              </a>
            </p>
          </section>
        </div>
      </div>

      {dialog === 'accept' && ruling && (
        <PersonDialog
          title="Accept the decision"
          text="The operator accepts this decision and waives the appeal window. Recovery from the operator can then run, within the agreed caps."
          busy={busy}
          error={err}
          onClose={() => setDialog(null)}
          onConfirm={(name) => run(() => api(`/rulings/${ruling.id}/operator-accept`, { body: { accepted_by: name } }))}
        />
      )}
      {dialog === 'appeal' && ruling && (
        <Modal title="Appeal the decision" onClose={() => setDialog(null)}>
          <form
            className="stack"
            onSubmit={(e) => {
              e.preventDefault();
              run(() => api(`/rulings/${ruling.id}/appeal`, { body: { note } }));
            }}
          >
            <p className="muted">A person reviews the appeal. While it is open, recovery from the operator is on hold; the buyer's refund is not affected.</p>
            <label className="field">
              Why the decision is wrong
              <textarea rows={5} value={note} onChange={(e) => setNote(e.target.value)} required />
            </label>
            <ErrorNote error={err} />
            <div className="row" style={{ justifyContent: 'flex-end' }}>
              <button type="button" className="btn secondary" onClick={() => setDialog(null)}>
                Cancel
              </button>
              <button className="btn" disabled={busy || !note.trim()}>
                {busy ? 'Sending…' : 'Send appeal'}
              </button>
            </div>
          </form>
        </Modal>
      )}
    </main>
  );
}
