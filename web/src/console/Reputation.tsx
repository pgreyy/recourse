import { api, ErrorNote, money, navigate, Policy, Status, useLoad, when, plural } from '../lib';

export function Reputation() {
  const r = useLoad((signal) => api<{ agents: any[]; operators: any[] }>('/console/agents', { signal }), []);
  // Decisions per operator, each linking to the operator's view of it.
  const cases = useLoad((signal) => api<any[]>('/console/cases', { signal }), []);
  const decisionsOf = (name: string) => (cases.data ?? []).filter((c) => c.operator === name && c.verdict_state === 'RULED');
  return (
    <div className="w stack" style={{ gap: 16 }}>
      <ErrorNote error={r.error} />
      {r.loading && !r.data && <p className="loading">Loading…</p>}
      {r.data && (
        <>
          <section className="card" aria-labelledby="agents-title">
            <div className="card-head">
              <h2 id="agents-title">Agent versions</h2>
              <span className="small muted">reliability = 1 − confirmed agent-fault amount ÷ amount bought</span>
            </div>
            <table className="plain">
              <thead>
                <tr>
                  <th>Agent version</th>
                  <th>Operator</th>
                  <th>Liability cover</th>
                  <th className="num">Reliability</th>
                  <th>Basis</th>
                  <th>Checkout policy</th>
                  <th>Reason</th>
                </tr>
              </thead>
              <tbody>
                {r.data.agents.map((a) => (
                  <tr key={a.agent_version.id}>
                    <td>
                      <strong>
                        {a.agent_version.name} v{a.agent_version.version}
                      </strong>
                    </td>
                    <td>{a.agent_version.operator.name}</td>
                    <td>{a.coverage.covered ? <Status tone="ok">Covered, v{a.coverage.agreement_version}</Status> : <Status tone="warn">Not covered</Status>}</td>
                    <td className="num" style={{ fontVariantNumeric: 'tabular-nums' }}>
                      {a.reliability === null || a.reliability === undefined ? '—' : a.reliability.toFixed(3)}
                    </td>
                    <td className="small muted">
                      {plural(a.basis.confirmed_agent_faults, 'confirmed fault')}, {a.basis.confirmed_fault_amount} of {a.basis.amount_bought} bought over {plural(a.basis.orders, 'order')}
                    </td>
                    <td>
                      {a.coverage.covered ? <Policy p={a.merchant_policy.policy} /> : <Status tone="warn">Buyer approval</Status>}
                    </td>
                    <td className="small">
                      {a.coverage.covered ? (a.merchant_policy.reason ? `${a.merchant_policy.reason} (${when(a.merchant_policy.last_fault_at)})` : 'No confirmed faults in 30 days') : 'No accepted liability agreement covers it'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
          <section className="card" aria-labelledby="ops-title">
            <div className="card-head">
              <h2 id="ops-title">Operators</h2>
              <span className="small muted">accountability = obligations paid ÷ (paid + failed)</span>
            </div>
            <table className="plain">
              <thead>
                <tr>
                  <th>Operator</th>
                  <th className="num">Accountability</th>
                  <th>Basis</th>
                  <th>Outstanding</th>
                  <th>Agreement</th>
                  <th>Decisions</th>
                </tr>
              </thead>
              <tbody>
                {r.data.operators.map((o) => (
                  <tr key={o.operator.id}>
                    <td>
                      <strong>{o.operator.name}</strong>
                      <div className="small muted mono">id {o.operator.id.slice(0, 8)}</div>
                    </td>
                    <td className="num">{o.accountability === null || o.accountability === undefined ? '—' : o.accountability.toFixed(2)}</td>
                    <td className="small muted">
                      {o.basis.obligations_paid} paid ({o.basis.paid_amount}), {o.basis.obligations_failed} failed
                    </td>
                    <td>
                      {plural(o.outstanding_exposure.obligations, 'obligation')}, {o.outstanding_exposure.amount}
                    </td>
                    <td className="small">
                      {o.agreement ? (
                        <>
                          v{o.agreement.version}: {money({ value: o.agreement.per_incident_cap, currency: o.agreement.currency })} per incident, {money({ value: o.agreement.aggregate_cap, currency: o.agreement.currency })} total,{' '}
                          {o.agreement.appeal_window_hours} h appeal window
                        </>
                      ) : (
                        <Status tone="warn">No accepted agreement</Status>
                      )}
                    </td>
                    <td className="small">
                      {decisionsOf(o.operator.name).length === 0 && <span className="muted">None</span>}
                      {decisionsOf(o.operator.name).map((c) => (
                        <div key={c.id}>
                          <a
                            href={`/app/operator/decision?case=${c.id}`}
                            onClick={(e) => {
                              e.preventDefault();
                              navigate(`/operator/decision?case=${c.id}`);
                            }}
                          >
                            <span className="mono">{c.case_ref}</span>
                          </a>
                        </div>
                      ))}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        </>
      )}
    </div>
  );
}
