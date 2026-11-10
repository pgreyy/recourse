import { useEffect, useRef, useState } from 'react';
import { api, ErrorNote, Id, Link, money, navigate, Status, useLoad, useLocation, when, type Tone } from '../lib';
import { Timeline, type Entry } from '../timeline';

type RunView = {
  run: { id: string; case_ref: string; status: string; agent: string; model: string | null; dry_run: boolean; started_at: string; finished_at: string | null; error: string | null };
  timeline: Entry[];
  order: null | { order_ref: string; status: string; total: { value: string; currency: string }; paypal_order_id: string | null; paypal_capture_id: string | null; compliance: string; receipt_path: string | null };
  anchor: null | { ok: boolean; paypal_debug_id: string | null; checks: Array<{ id: string; ok: boolean; detail: string }> };
};

export function AgentRun() {
  const { query } = useLocation();
  const runId = query.get('run');
  const versions = useLoad(() => api<Array<{ agent_version_id: string; name: string; version: string; profile: string; operator: string }>>('/agent/versions'), []);
  const mandates = useLoad(() => api<Array<{ id: string; version: number; status: string; source_text: string; buyer_email: string }>>('/console/mandates'), []);
  const runs = useLoad(() => api<Array<{ id: string; case_ref: string; status: string; dry_run: boolean; started_at: string; agent: string }>>('/console/runs'), [runId]);
  const [av, setAv] = useState('');
  const [mandate, setMandate] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<Error | null>(null);

  const active = (mandates.data ?? []).filter((m) => m.status === 'ACTIVE');
  const avId = av || versions.data?.[0]?.agent_version_id || '';
  const mId = mandate || active[0]?.id || '';

  async function start() {
    setBusy(true);
    setErr(null);
    try {
      const r = await api<{ run_id?: string }>('/agent/run', { body: { mandate_id: mId, agent_version_id: avId, async: true } });
      if (r.run_id) navigate(`/agent?run=${r.run_id}`);
    } catch (e) {
      setErr(e as Error);
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="page">
      <div className="page-head">
        <div>
          <h1>Agent run</h1>
          <p>Pick an agent version and a signed mandate, then watch every step it takes. Each step is written to a hash-chained flight recorder, and the chain is anchored in the PayPal order at checkout.</p>
        </div>
      </div>
      <div className="grid2 grid-run" style={{ alignItems: 'start' }}>
        <aside className="stack">
          <section className="card card-pad stack" aria-labelledby="start-title">
            <h2 id="start-title">Start a run</h2>
            <label className="field">
              Agent version
              <select value={avId} onChange={(e) => setAv(e.target.value)}>
                {(versions.data ?? []).map((v) => (
                  <option key={v.agent_version_id} value={v.agent_version_id}>
                    {v.name} v{v.version} ({v.profile})
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              Mandate (signed, active)
              <select value={mId} onChange={(e) => setMandate(e.target.value)}>
                {active.length === 0 && <option value="">No active mandate</option>}
                {active.map((m) => (
                  <option key={m.id} value={m.id}>
                    v{m.version}: {m.source_text.slice(0, 60)}
                  </option>
                ))}
              </select>
            </label>
            <div className="row">
              <button className="btn" onClick={start} disabled={busy || !avId || !mId}>
                {busy ? 'Starting…' : 'Run agent'}
              </button>
              <span className="small muted">Buys for real in the PayPal sandbox.</span>
            </div>
            <ErrorNote error={err || versions.error || mandates.error} />
          </section>
          <section className="card card-pad stack" aria-labelledby="past-title">
            <h2 id="past-title">Recorded runs</h2>
            <ul className="stack" style={{ listStyle: 'none', margin: 0, padding: 0, gap: 6 }}>
              {(runs.data ?? []).slice(0, 8).map((r) => (
                <li key={r.id}>
                  <Link to={`/agent?run=${r.id}`} current={r.id === runId}>
                    {r.agent}
                  </Link>{' '}
                  <span className="small muted">
                    {when(r.started_at)}, {r.status.replace(/_/g, ' ').toLowerCase()}
                    {r.dry_run && r.status !== 'DRY_RUN' ? ', dry run' : ''}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        </aside>
        {runId ? <RunPanel key={runId} id={runId} /> : <section className="card card-pad muted">Start a run, or open a recorded one, to see its timeline.</section>}
      </div>
    </main>
  );
}

const RUN_STATUS: Record<string, [Tone, string]> = {
  RUNNING: ['neutral', 'Running'],
  PURCHASED: ['ok', 'Purchased'],
  STEP_UP_REQUIRED: ['warn', 'Buyer approval required'],
  NO_PURCHASE: ['neutral', 'No purchase'],
  FAILED: ['bad', 'Failed'],
  DRY_RUN: ['neutral', 'Dry run'],
};

function RunPanel({ id }: { id: string }) {
  const [view, setView] = useState<RunView | null>(null);
  const [err, setErr] = useState<Error | null>(null);
  const seen = useRef(new Set<number>());
  const [fresh, setFresh] = useState<Set<number>>(new Set());

  useEffect(() => {
    let stop = false;
    let timer: number | undefined;
    const tick = async () => {
      try {
        const v = await api<RunView>(`/console/runs/${id}`);
        if (stop) return;
        const firstLoad = seen.current.size === 0;
        const added = new Set(v.timeline.map((e) => e.seq).filter((s) => !seen.current.has(s)));
        v.timeline.forEach((e) => seen.current.add(e.seq));
        // Animate only steps that arrive while watching, not a recorded run opened after the fact.
        setFresh(firstLoad && v.run.finished_at ? new Set() : added);
        setView(v);
        if (!v.run.finished_at) timer = window.setTimeout(tick, 1000);
      } catch (e) {
        if (!stop) setErr(e as Error);
      }
    };
    tick();
    return () => {
      stop = true;
      window.clearTimeout(timer);
    };
  }, [id]);

  if (err) return <ErrorNote error={err} />;
  if (!view) return <section className="card card-pad loading">Loading the run…</section>;
  const { run, order, anchor } = view;
  const [tone, label] = RUN_STATUS[run.status] ?? ['neutral', run.status];
  const warn = view.timeline.find((e) => e.kind === 'checkout.firewall' && e.tone === 'warn');
  const proceeded = view.timeline.find((e) => e.kind === 'checkout.started' && (e.payload as any)?.proceeded_despite_warnings);
  return (
    <div className="stack">
      <section className="card" aria-labelledby="run-title" aria-busy={!run.finished_at}>
        <div className="card-head">
          <div>
            <h2 id="run-title">{run.agent}</h2>
            <p className="small muted">
              {run.case_ref}, started {when(run.started_at)}
              {run.model ? `, model ${run.model}` : ''}
            </p>
          </div>
          <span aria-live="polite">
            <Status tone={tone}>{run.finished_at ? label : 'Running'}</Status>
          </span>
        </div>
        <div className="card-pad">
          {warn && proceeded && (
            <p className="callout" style={{ marginBottom: 12 }}>
              Warned at step {warn.seq}, proceeded at step {proceeded.seq}.
            </p>
          )}
          <Timeline entries={view.timeline} highlight={[warn?.seq, proceeded?.seq].filter((x): x is number => Boolean(x && proceeded))} fresh={fresh} />
          {!run.finished_at && <p className="small muted" style={{ marginTop: 8 }}>Waiting for the next step…</p>}
          {run.error && <p className="error">{run.error}</p>}
        </div>
      </section>

      {run.finished_at && order && (
        <section className="card" aria-labelledby="paypal-title">
          <div className="card-head">
            <h2 id="paypal-title">PayPal order</h2>
            {anchor && <Status tone={anchor.ok ? 'ok' : 'bad'}>{anchor.ok ? 'Decision trail anchored' : 'Anchor check failed'}</Status>}
          </div>
          <div className="card-pad grid2">
            <dl className="kv">
              <dt>Order ref</dt>
              <dd>{order.order_ref}</dd>
              <dt>Amount</dt>
              <dd>{money(order.total)}</dd>
              <dt>PayPal order</dt>
              <dd>
                <Id>{order.paypal_order_id ?? 'none'}</Id>
              </dd>
              <dt>PayPal capture</dt>
              <dd>
                <Id>{order.paypal_capture_id ?? 'none'}</Id>
              </dd>
              <dt>Compliance</dt>
              <dd>{order.compliance === 'WARNING' ? <Status tone="warn">Bought with a warning</Status> : <Status tone="ok">{order.compliance.toLowerCase()}</Status>}</dd>
              {order.receipt_path && (
                <>
                  <dt>Buyer receipt</dt>
                  <dd>
                    <a href={order.receipt_path}>Open the receipt</a>
                  </dd>
                </>
              )}
            </dl>
            {anchor && (
              <div>
                <h3 style={{ marginBottom: 6 }}>Decision trail anchored in the PayPal order</h3>
                <ul className="checklist">
                  {anchor.checks.map((c) => (
                    <li key={c.id}>
                      <Status tone={c.ok ? 'ok' : 'bad'}>{c.ok ? 'Match' : 'Mismatch'}</Status>
                      <span style={{ overflowWrap: 'anywhere' }}>{c.detail}</span>
                    </li>
                  ))}
                </ul>
                <p className="small muted" style={{ marginTop: 6 }}>
                  Re-read from PayPal just now{anchor.paypal_debug_id ? ` (debug id ${anchor.paypal_debug_id})` : ''}.
                </p>
              </div>
            )}
          </div>
        </section>
      )}
    </div>
  );
}
