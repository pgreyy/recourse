import { useState } from 'react';
import { api, ErrorNote, Id, money, navigate, Status, short, useLoad, useLocation, when, type Tone, maskEmail, plural } from '../lib';

const EXAMPLE = "Running shoes, US men's 10, under $120, Kestrel or Sorin, by Friday";

export function Buyer() {
  const { query } = useLocation();
  const id = query.get('mandate');
  const paypal = query.get('paypal');
  const [text, setText] = useState(EXAMPLE);
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<Error | null>(null);
  const m = useLoad(() => (id ? api(`/mandates/${id}`) : Promise.resolve(null)), [id]);

  async function compile() {
    setBusy('compile');
    setErr(null);
    try {
      const r = await api<{ id: string }>('/mandates', { body: { buyer_email: email, text } });
      navigate(`/buyer?mandate=${r.id}`);
    } catch (e) {
      setErr(e as Error);
    } finally {
      setBusy(null);
    }
  }
  async function approve() {
    setBusy('approve');
    setErr(null);
    try {
      const r = await api<{ approve_url: string }>(`/mandates/${id}/approve`, { body: {} });
      window.location.href = r.approve_url;
    } catch (e) {
      setErr(e as Error);
      setBusy(null);
    }
  }

  const d = m.data;
  return (
    <main className="page">
      <div className="page-head">
        <div>
          <h1>Buyer instructions</h1>
          <p>Say what the agent may buy, in plain English. Recourse compiles it into rules, and the agent can only buy within them. Approve once with PayPal; Recourse signs the rules.</p>
        </div>
        {id && (
          <button className="btn secondary" onClick={() => navigate('/buyer')}>
            New instructions
          </button>
        )}
      </div>
      {paypal === 'approved' && d?.status === 'ACTIVE' && (
        <div className="notice" role="status" style={{ marginBottom: 16 }}>
          PayPal approval received. The instructions are signed and active.
        </div>
      )}
      {paypal === 'cancelled' && <div className="notice warn" role="status" style={{ marginBottom: 16 }}>PayPal approval was cancelled. The instructions are still a draft.</div>}
      <div className="grid2" style={{ alignItems: 'start' }}>
        <section className="card" aria-labelledby="words-title">
          <div className="card-head">
            <h2 id="words-title">In your words</h2>
            {d && <span className="small muted">version {d.version}</span>}
          </div>
          <div className="card-pad stack">
            {d ? (
              <>
                <p className="quote">{d.source_text}</p>
                <dl className="kv">
                  <dt>Buyer</dt>
                  <dd>{maskEmail(d.buyer_email)}</dd>
                  <dt>Compiled by</dt>
                  <dd>
                    {d.llm?.provider}/{d.llm?.model}, then checked by code against the schema
                  </dd>
                  <dt>Created</dt>
                  <dd>{when(d.created_at)}</dd>
                </dl>
              </>
            ) : (
              <form
                className="stack"
                onSubmit={(e) => {
                  e.preventDefault();
                  compile();
                }}
              >
                <label className="field">
                  What should the agent buy?
                  <textarea rows={4} value={text} onChange={(e) => setText(e.target.value)} required minLength={3} maxLength={2000} />
                </label>
                <label className="field">
                  Your email
                  <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required placeholder="buyer@example.com" />
                </label>
                <div>
                  <button className="btn" disabled={busy !== null}>
                    {busy === 'compile' ? 'Compiling…' : 'Compile rules'}
                  </button>
                </div>
                <p className="small muted">The model only drafts the rules. Code checks them; a draft that fails is rejected and nothing is saved.</p>
              </form>
            )}
            <ErrorNote error={err || m.error} />
          </div>
        </section>

        <section className="card" aria-labelledby="rules-title">
          <div className="card-head">
            <h2 id="rules-title">Compiled rules</h2>
            {d && <MandateStatus s={d.status} />}
          </div>
          <div className="card-pad stack">
            {!d && !m.loading && <p className="muted">The rules appear here, side by side with your words, before anything is approved.</p>}
            {m.loading && id && <p className="loading">Loading…</p>}
            {d && <Rules spec={d.spec} />}
            {d && (
              <>
                <hr className="rule" />
                {d.status === 'DRAFT' && (
                  <div className="row">
                    <button className="btn paypal" onClick={approve} disabled={busy !== null}>
                      {busy === 'approve' ? 'Opening PayPal…' : 'Approve with PayPal'}
                    </button>
                    <span className="small muted">Saves your PayPal for these instructions only. Nothing is charged now.</span>
                  </div>
                )}
                {d.status !== 'DRAFT' && (
                  <dl className="kv">
                    <dt>Signature</dt>
                    <dd className="row">
                      <Status tone={d.signature_valid ? 'ok' : 'bad'}>{d.signature_valid ? 'Valid' : 'Not valid'}</Status>
                      <span className="small muted">{d.signing_key_id}</span>
                    </dd>
                    <dt>Hash</dt>
                    <dd>
                      <Id title={d.mandate_hash}>{short(d.mandate_hash, 24)}</Id>
                    </dd>
                    <dt>Signed</dt>
                    <dd>{when(d.signed_at)}</dd>
                    <dt>Budget left</dt>
                    <dd>
                      {money(d.remaining_budget?.remaining)} of {money(d.remaining_budget?.max_total)}, {plural(d.remaining_budget?.orders_remaining, 'order')} left
                    </dd>
                  </dl>
                )}
              </>
            )}
          </div>
        </section>
      </div>
    </main>
  );
}

function MandateStatus({ s }: { s: string }) {
  const map: Record<string, [Tone, string]> = {
    DRAFT: ['neutral', 'Draft, not approved'],
    ACTIVE: ['ok', 'Active, signed'],
    SUPERSEDED: ['neutral', 'Superseded'],
    REVOKED: ['bad', 'Revoked'],
    EXPIRED: ['neutral', 'Expired'],
  };
  const [tone, label] = map[s] ?? ['neutral', s];
  return <Status tone={tone}>{label}</Status>;
}

const yesNo = (b: boolean) => (b ? 'Allowed' : 'Not allowed');

function Rules({ spec }: { spec: any }) {
  const rows: Array<[string, string]> = [
    ['Category', spec.category],
    ['Total budget', `${money(spec.max_total)}, all orders, tax and shipping included`],
    ...spec.attributes.map((a: any): [string, string] => [
      a.name.replace(/^\w/, (c: string) => c.toUpperCase()),
      [a.unit_system, a.gender ? `${a.gender}'s` : null, a.value].filter(Boolean).join(' ') + (a.unit_system ? ` (value and size system must both match)` : ''),
    ]),
    ['Brands', spec.brands_allowed.length ? spec.brands_allowed.join(', ') : 'Any brand'],
    ['Merchants', spec.merchants_allowed?.length ? spec.merchants_allowed.join(', ') : 'Any merchant'],
    ['Quantity', String(spec.quantity)],
    ['Orders', `At most ${spec.max_orders}`],
    ['Substitutions', yesNo(spec.allow_substitutions)],
    ['Split orders', yesNo(spec.allow_split_orders)],
    ['Delivered by', spec.deadline],
    ['Authority ends', when(spec.expires_at)],
  ];
  return (
    <table className="plain" aria-label="Rules the agent must follow">
      <tbody>
        {rows.map(([k, v]) => (
          <tr key={k}>
            <th scope="row" style={{ width: 150, textTransform: 'none', letterSpacing: 0, fontSize: 13 }}>
              {k}
            </th>
            <td>{v}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
