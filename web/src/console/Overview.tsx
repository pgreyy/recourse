import { api, ErrorNote, money, moneyList, navigate, SettlementStatus, Status, useLoad, Verdict, when } from '../lib';

type OverviewData = {
  agent_purchases: { count: number; amount: Array<{ value: string; currency: string }> };
  cases_open: number;
  recovered_confirmed: { count: number; amount: Array<{ value: string; currency: string }> };
  pending_settlement: { count: number; amount: Array<{ value: string; currency: string }> };
  exposure: Array<{ agreement_id: string; operator: string; agreement_version: number; cap: any; used: any; remaining: any }>;
  dispute_costs_avoided_estimate: { cases_resolved_without_dispute: number; assumed_fee_per_dispute: any; amount: any; basis: string };
};

const useOverview = () => useLoad((signal) => api<OverviewData>('/console/overview', { signal }), []);

function Amount({ list }: { list: Array<{ value: string; currency: string }> }) {
  if (!list.length) return <>0.00</>;
  return (
    <>
      {list.map((m, i) => (
        <span key={m.currency}>
          {i > 0 && ' + '}
          {Number(m.value).toLocaleString('en-US', { minimumFractionDigits: 2 })}
          <span className="cur">{m.currency}</span>
        </span>
      ))}
    </>
  );
}

export function Kpis() {
  const o = useOverview();
  const d = o.data;
  const used = d?.exposure.reduce((s, e) => s + Number(e.used.value), 0) ?? 0;
  const cap = d?.exposure.reduce((s, e) => s + Number(e.cap.value), 0) ?? 0;
  return (
    <div className="w" style={{ padding: 0, background: 'transparent', overflow: 'visible' }}>
      <ErrorNote error={o.error} />
      <section className="kpis" aria-label="Overview" aria-busy={o.loading}>
        <div className="kpi">
          <span className="label">Agent purchases</span>
          <span className="value">{d ? d.agent_purchases.count : '…'}</span>
          <span className="sub">{d ? moneyList(d.agent_purchases.amount) : ''} captured</span>
        </div>
        <div className="kpi">
          <span className="label">Cases open</span>
          <span className="value">{d ? d.cases_open : '…'}</span>
          <span className="sub">not yet closed</span>
        </div>
        <div className="kpi">
          <span className="label">Recovered</span>
          <span className="value">{d ? <Amount list={d.recovered_confirmed.amount} /> : '…'}</span>
          <span className="sub">confirmed by PayPal only, {d?.recovered_confirmed.count ?? 0} case(s)</span>
        </div>
        <div className="kpi">
          <span className="label">Pending</span>
          <span className="value">{d ? <Amount list={d.pending_settlement.amount} /> : '…'}</span>
          <span className="sub">{d?.pending_settlement.count ?? 0} settlement(s) not yet confirmed</span>
        </div>
        <div className="kpi">
          <span className="label">Exposure used</span>
          <span className="value">
            {d ? used.toFixed(2) : '…'}
            <span className="cur">of {cap.toFixed(2)} agreed</span>
          </span>
          <div className="meter" role="img" aria-label={`${cap ? Math.round((used / cap) * 100) : 0}% of agreed caps used`}>
            <span style={{ width: `${cap ? Math.min(100, (used / cap) * 100) : 0}%` }} />
          </div>
        </div>
        <div className="kpi estimate">
          <span className="label">
            Dispute costs avoided <Status tone="neutral">Estimate</Status>
          </span>
          <span className="value">{d ? <Amount list={[d.dispute_costs_avoided_estimate.amount]} /> : '…'}</span>
          <span className="sub">
            {d?.dispute_costs_avoided_estimate.cases_resolved_without_dispute ?? 0} case(s) settled without a PayPal dispute × {money(d?.dispute_costs_avoided_estimate.assumed_fee_per_dispute)} assumed fee
          </span>
        </div>
      </section>
    </div>
  );
}

export function RecoveredByAgent() {
  const r = useLoad((signal) => api<{ rows: Array<{ agent_version: string; cases: number; recovered: any; last_confirmed_at: string }> }>('/console/recovered-by-agent-version', { signal }), []);
  const max = Math.max(1, ...(r.data?.rows ?? []).map((x) => Number(x.recovered.value)));
  return (
    <section className="card" style={{ height: '100%', overflow: 'auto' }} aria-labelledby="rba-title">
      <div className="card-head">
        <h2 id="rba-title">Recovered by agent version</h2>
        <span className="small muted">confirmed only, all time</span>
      </div>
      <div className="card-pad">
        <ErrorNote error={r.error} />
        {r.data && r.data.rows.length === 0 && <p className="muted">No confirmed recoveries yet.</p>}
        <table className="plain">
          <tbody>
            {(r.data?.rows ?? []).map((x) => (
              <tr key={x.agent_version}>
                <td style={{ width: '40%' }}>
                  <strong>{x.agent_version}</strong>
                  <div className="small muted">
                    {x.cases} case(s), last {when(x.last_confirmed_at)}
                  </div>
                </td>
                <td style={{ width: '40%' }}>
                  <div className="meter" aria-hidden="true" style={{ height: 10, marginTop: 6 }}>
                    <span style={{ width: `${(Number(x.recovered.value) / max) * 100}%` }} />
                  </div>
                </td>
                <td className="num nowrap">{money(x.recovered)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

export function ExposureWidget() {
  const o = useOverview();
  return (
    <section className="card" style={{ height: '100%', overflow: 'auto' }} aria-labelledby="exp-title">
      <div className="card-head">
        <h2 id="exp-title">Operator exposure</h2>
        <span className="small muted">accepted agreements</span>
      </div>
      <div className="card-pad">
        <ErrorNote error={o.error} />
        <div className="scroll-x">
        <table className="plain">
          <thead>
            <tr>
              <th>Operator</th>
              <th className="num">Used</th>
              <th className="num">Remaining</th>
              <th className="num">Cap</th>
            </tr>
          </thead>
          <tbody>
            {(o.data?.exposure ?? []).map((e) => (
              <tr key={e.agreement_id}>
                <td>
                  {e.operator} <span className="small muted">agreement v{e.agreement_version}</span>
                </td>
                <td className="num">{money(e.used)}</td>
                <td className="num">{money(e.remaining)}</td>
                <td className="num">{money(e.cap)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
      </div>
    </section>
  );
}

/** What each case is waiting for, worked out from its state. */
export function nextStep(c: any): string | null {
  if (c.status === 'CLOSED') return null;
  if (c.verdict_state === 'NOT_ASSESSED') return 'Assess';
  if (c.verdict_state === 'ASSESSED') return c.verdict === 'INCONCLUSIVE' ? 'Review evidence' : 'Approve ruling';
  if (c.ruling_status === 'APPEALED') return 'Decide appeal';
  if (c.verdict === 'AGENT_FAULT' && !c.operator_accepted && c.settlement_status !== 'RECOVERED') return 'Operator acceptance';
  if (c.settlement_status && !['RECOVERED', 'COMPLETED', 'NO_ACTION'].includes(c.settlement_status)) return 'Settlement in progress';
  return null;
}

export function AttentionList() {
  const r = useLoad((signal) => api<any[]>('/console/cases', { signal }), []);
  const rows = (r.data ?? []).map((c) => ({ c, step: nextStep(c) })).filter((x) => x.step);
  return (
    <section className="card" style={{ height: '100%', overflow: 'auto' }} aria-labelledby="att-title">
      <div className="card-head">
        <h2 id="att-title">Needs a decision</h2>
        <span className="small muted">{r.data ? `${rows.length} of ${r.data.length} cases` : ''}</span>
      </div>
      <ErrorNote error={r.error} />
      <div className="scroll-x">
      <table className="plain">
        <thead>
          <tr>
            <th>Case</th>
            <th>Agent</th>
            <th className="num">Amount</th>
            <th>Verdict</th>
            <th>Settlement</th>
            <th>Waiting for</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(({ c, step }) => (
            <tr key={c.id}>
              <td>
                <a
                  href={`/app/console?page=case&case=${c.id}`}
                  onClick={(e) => {
                    e.preventDefault();
                    navigate(`/console?page=case&case=${c.id}`);
                  }}
                >
                  {c.case_ref}
                </a>
                <div className="small muted">{c.source === 'PAYPAL_DISPUTE' ? `PayPal dispute ${c.dispute_id}` : 'Buyer report'}</div>
              </td>
              <td>{c.agent ?? '—'}</td>
              <td className="num">{money(c.amount)}</td>
              <td>
                <Verdict v={c.verdict} />
                {c.verdict_state === 'ASSESSED' && <div className="small muted">proposed, not ruled</div>}
              </td>
              <td>
                <SettlementStatus s={c.settlement_status} />
              </td>
              <td>
                <strong>{step}</strong>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      </div>
    </section>
  );
}
