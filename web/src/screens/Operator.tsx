import { useState } from 'react';
import { api, ErrorNote, Id, Link, Modal, money, navigate, Status, short, useLoad, useLocation, when, maskEmail, Notice, BackButton } from '../lib';

type Agreement = {
  id: string;
  version: number;
  status: 'DRAFT' | 'ACCEPTED' | 'SUPERSEDED' | 'REVOKED';
  terms: any;
  terms_hash: string;
  terms_hash_valid: boolean;
  acceptance: null | { accepted_at: string; accepted_by: { name: string; email: string }; signature_valid?: boolean; signing_key_id?: string };
};

export function Operator() {
  const { query } = useLocation();
  const ops = useLoad(() => api<Array<{ id: string; name: string; agents: number }>>('/console/operators'), []);
  // Default: the travel demo's operator (the one with the most agents).
  const opId = query.get('operator') ?? (ops.data ?? []).find((o: any) => o.name === 'Wayfare Agents')?.id ?? [...(ops.data ?? [])].sort((a, b) => b.agents - a.agents)[0]?.id ?? null;
  const paypal = query.get('paypal');

  return (
    <main className="page">
      <div className="page-head">
        <div>
          <BackButton />
          <h1>Operator onboarding</h1>
          <p>
            An agent operator signs a liability agreement before its agents shop. It sets how much Recourse may recover from the operator when its agent breaks a
            buyer's instructions, and how the operator can appeal.
          </p>
        </div>
        {ops.data && (
          <label className="field" style={{ minWidth: 240 }}>
            Operator
            <select value={opId ?? ''} onChange={(e) => navigate(`/operator?operator=${e.target.value}`)}>
              {ops.data.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.name} ({o.agents} agent{o.agents === 1 ? '' : 's'})
                </option>
              ))}
            </select>
          </label>
        )}
      </div>
      <ErrorNote error={ops.error} />
      {paypal === 'approved' && <div className="notice" role="status" style={{ marginBottom: 16 }}>PayPal approval received. The operator's PayPal is now saved under the accepted agreement.</div>}
      {paypal === 'cancelled' && <div className="notice warn" role="status" style={{ marginBottom: 16 }}>PayPal approval was cancelled. Nothing was saved.</div>}
      {opId && <OperatorDetail key={opId} id={opId} />}
    </main>
  );
}

function OperatorDetail({ id }: { id: string }) {
  const op = useLoad(() => api(`/operators/${id}`), [id]);
  const ag = useLoad(() => api<{ current: Agreement | null; versions: Agreement[] }>(`/operators/${id}/liability-agreement`), [id]);
  const agents = useLoad(() => api('/console/agents'), []);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<Error | null>(null);
  const [accepting, setAccepting] = useState(false);

  const latest = ag.data?.versions?.[0] ?? null;
  const shown = latest?.status === 'DRAFT' ? latest : ag.data?.current ?? latest;
  const ready = op.data?.onboarding?.ready;
  const pmStatus = op.data?.onboarding?.payment_method?.status;

  async function act(name: string, fn: () => Promise<void>) {
    setBusy(name);
    setErr(null);
    try {
      await fn();
    } catch (e) {
      setErr(e as Error);
    } finally {
      setBusy(null);
    }
  }

  const draft = () =>
    act('draft', async () => {
      await api(`/operators/${id}/liability-agreement`, { body: {} });
      ag.reload();
      op.reload();
    });
  const approve = () =>
    act('approve', async () => {
      const r = await api<{ approve_url: string }>(`/operators/${id}/approve`, { body: {} });
      window.location.href = r.approve_url;
    });

  const t = shown?.terms;
  return (
    <div className="grid2 grid-op" style={{ alignItems: 'start' }}>
      <section className="card" aria-labelledby="agreement-title">
        <div className="card-head">
          <h2 id="agreement-title">{t ? `Liability agreement, version ${shown!.version}` : 'Liability agreement'}</h2>
          {shown && <AgreementStatus a={shown} />}
        </div>
        <div className="card-pad stack">
          <ErrorNote error={ag.error || op.error || err} />
          {ag.loading && !ag.data && <p className="loading">Loading the agreement…</p>}
          {ag.data && !shown && (
            <div className="stack">
              <p>This operator has no agreement yet. Prepare one with the standard terms: 150.00 USD per incident, 500.00 USD in total, a 72 hour appeal window.</p>
              <div>
                <button className="btn" onClick={draft} disabled={busy !== null}>
                  {busy === 'draft' ? 'Preparing…' : 'Prepare agreement'}
                </button>
              </div>
            </div>
          )}
          {t && (
            <>
              <p className="muted">
                Between Recourse and <strong style={{ color: 'var(--ink)' }}>{t.operator.name}</strong> ({maskEmail(t.operator.email)}). Merchants:{' '}
                {t.covered_merchants.map((m: any) => m.name).join(', ')}. Categories: {t.categories.join(', ')}.
              </p>
              <div className="grid3">
                <Term label="Per incident cap" value={money(t.per_incident_cap)} />
                <Term label="Total cap" value={money(t.aggregate_cap)} />
                <Term label="Appeal window" value={`${t.appeal_window_hours} hours`} />
              </div>
              <div className="steps-box">
                <Steps
                  accepted={shown!.status === 'ACCEPTED'}
                  acceptance={shown!.acceptance}
                  paymentStatus={pmStatus}
                  ready={Boolean(ready)}
                  busy={busy}
                  onAccept={() => setAccepting(true)}
                  onApprove={approve}
                  isDraft={shown!.status === 'DRAFT'}
                />
              </div>
              <Clause title="Fault definition" text={t.agent_fault_definition} />
              <Clause title="Evidence standard" text={t.evidence_standard} />
              <Clause title="Payment" text={t.payment_terms} />
              <Clause title="Revocation" text={t.revocation_terms} />
              <Notice id="operator-sandbox-disclosure" summary="Sandbox: the operator's saved PayPal can be charged only by the demo merchant.">
                {t.disclosure.replace(/^Sandbox disclosure:\s*/i, '').replace(/^\w/, (x: string) => x.toUpperCase())}
              </Notice>
              <div>
                <h3 style={{ marginBottom: 6 }}>Agent versions covered</h3>
                <p>{t.covered_agent_versions.map((v: any) => `${v.agent_name} v${v.version}`).join(', ')}</p>
              </div>
              <p className="small muted">
                Terms hash <Id>{short(shown!.terms_hash, 16)}</Id> {shown!.terms_hash_valid ? '(matches the terms shown)' : '(does not match the terms shown)'}
              </p>
            </>
          )}
        </div>
      </section>

      <aside className="stack">
        <section className="card card-pad stack" aria-labelledby="why-title">
          <h2 id="why-title">Why operators sign</h2>
          <dl className="why">
            <dt>
              <Status tone="ok">Covered</Status>
            </dt>
            <dd>Covered agents shop under normal checkout policy.</dd>
            <dt>
              <Status tone="warn">Not covered</Status>
            </dt>
            <dd>Uncovered agents need the buyer's approval at PayPal on every purchase.</dd>
          </dl>
          {agents.data && (
            <table className="plain" aria-label="Agent versions and coverage">
              <thead>
                <tr>
                  <th>Agent version</th>
                  <th>Operator</th>
                  <th>At checkout</th>
                </tr>
              </thead>
              <tbody>
                {agents.data.agents.map((a: any) => (
                  <tr key={a.agent_version.id}>
                    <td>
                      {a.agent_version.name} v{a.agent_version.version}
                    </td>
                    <td className="muted">{a.agent_version.operator.name}</td>
                    <td>
                      {a.coverage.covered ? (
                        a.merchant_policy.policy === 'normal' ? (
                          <Status tone="ok">Normal policy</Status>
                        ) : (
                          <Status tone="warn">{a.merchant_policy.policy === 'suspended' ? 'Suspended' : 'Step-up'}</Status>
                        )
                      ) : (
                        <Status tone="warn">Buyer approval</Status>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <p className="small muted">
            Read live from the merchant's checkout policy. A covered agent with a recent confirmed fault also moves to step-up; see the{' '}
            <Link to="/console?page=agents">console</Link>.
          </p>
        </section>
      </aside>

      {accepting && shown && (
        <AcceptDialog
          defaultName={op.data?.name ?? ''}
          defaultEmail={op.data?.email ?? ''}
          version={shown.version}
          onClose={() => setAccepting(false)}
          onAccept={(by) =>
            act('accept', async () => {
              await api(`/operators/${id}/liability-agreement/${shown.version}/accept`, { body: { accepted_by: by } });
              setAccepting(false);
              ag.reload();
              op.reload();
            })
          }
          busy={busy === 'accept'}
          error={err}
        />
      )}
    </div>
  );
}

function AgreementStatus({ a }: { a: Agreement }) {
  const map = { DRAFT: ['neutral', 'Draft, not accepted'], ACCEPTED: ['ok', 'Accepted'], SUPERSEDED: ['neutral', 'Superseded'], REVOKED: ['bad', 'Revoked'] } as const;
  const [tone, label] = map[a.status];
  return <Status tone={tone}>{label}</Status>;
}

function Term({ label, value }: { label: string; value: string }) {
  return (
    <div className="kpi">
      <span className="label">{label}</span>
      <span className="value" style={{ fontSize: 21 }}>
        {value}
      </span>
    </div>
  );
}

function Clause({ title, text }: { title: string; text: string }) {
  return (
    <div>
      <h3 style={{ marginBottom: 4 }}>{title}</h3>
      <p>{text}</p>
    </div>
  );
}

function Steps(p: {
  isDraft: boolean;
  accepted: boolean;
  acceptance: Agreement['acceptance'];
  paymentStatus?: string;
  ready: boolean;
  busy: string | null;
  onAccept: () => void;
  onApprove: () => void;
}) {
  return (
    <ol className="stack" style={{ listStyle: 'none', padding: 0, margin: 0 }} aria-label="Onboarding steps">
      <li className="row">
        <span className="mono muted">1</span>
        <strong>Accept the agreement</strong>
        <span className="spacer" />
        {p.accepted ? (
          <span className="row small">
            <Status tone="ok">Accepted</Status>
            <span className="muted">
              by {p.acceptance?.accepted_by?.name} on {when(p.acceptance?.accepted_at)}, signed by Recourse
            </span>
          </span>
        ) : (
          <button className="btn" onClick={p.onAccept} disabled={!p.isDraft || p.busy !== null}>
            Accept
          </button>
        )}
      </li>
      <li className="row">
        <span className="mono muted">2</span>
        <strong>Save the operator's PayPal under it</strong>
        <span className="spacer" />
        {p.ready ? (
          <Status tone="ok">PayPal saved</Status>
        ) : (
          <button className="btn paypal" onClick={p.onApprove} disabled={!p.accepted || p.busy !== null}>
            {p.busy === 'approve' ? 'Opening PayPal…' : 'Continue to PayPal'}
          </button>
        )}
      </li>
      {!p.ready && p.accepted && p.paymentStatus && p.paymentStatus !== 'NONE' && (
        <li className="small muted">The saved PayPal belongs to an earlier agreement version; approve again for this one.</li>
      )}
      {p.ready && <li className="small muted">Ready. Agents covered by this agreement shop under normal policy.</li>}
    </ol>
  );
}

function AcceptDialog(p: {
  defaultName: string;
  defaultEmail: string;
  version: number;
  busy: boolean;
  error: Error | null;
  onClose: () => void;
  onAccept: (by: { name: string; email: string }) => void;
}) {
  const [name, setName] = useState(p.defaultName);
  const [email, setEmail] = useState(p.defaultEmail);
  return (
    <Modal title={`Accept agreement version ${p.version}`} onClose={p.onClose}>
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          p.onAccept({ name, email });
        }}
      >
        <p className="muted">Recourse signs the acceptance with its Ed25519 key. The terms hash is part of the signed record.</p>
        <label className="field">
          Accepted by (name)
          <input value={name} onChange={(e) => setName(e.target.value)} required />
        </label>
        <label className="field">
          Email
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
        </label>
        <ErrorNote error={p.error} />
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button type="button" className="btn secondary" onClick={p.onClose}>
            Cancel
          </button>
          <button className="btn" disabled={p.busy}>
            {p.busy ? 'Accepting…' : 'Accept and sign'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
