import { Link } from '../lib';

const STEPS = [
  { to: '/operator', n: '1', title: 'Operator signs', text: 'The agent operator accepts a liability agreement with caps and an appeal window, and saves a PayPal payment method under it.' },
  { to: '/buyer', n: '2', title: 'Buyer sets a mandate', text: 'The buyer says what the agent may buy in plain English, sees the compiled rules and approves once through PayPal.' },
  { to: '/agent', n: '3', title: 'Agent buys', text: 'Every step is recorded in a hash chain. A checkout firewall checks the mandate, and the trail is anchored in the PayPal order.' },
  { to: '/console', n: '4', title: 'Recourse settles', text: 'When a purchase goes wrong, Recourse works out who is responsible and settles on PayPal within the limits the operator agreed to.' },
];

export function Home() {
  return (
    <main className="page">
      <div className="page-head">
        <div>
          <h1>The liability layer for agentic commerce</h1>
          <p>A buyer signs a mandate, an agent buys, every decision is recorded and anchored in the PayPal order. When a purchase goes wrong, Recourse works out who is responsible and settles it on PayPal.</p>
        </div>
      </div>
      <ol className="ledger-steps">
        {STEPS.map((s) => (
          <li key={s.to}>
            <span className="n">Step {s.n}</span>
            <h2>
              <Link to={s.to}>{s.title}</Link>
            </h2>
            <p className="muted">{s.text}</p>
          </li>
        ))}
      </ol>
    </main>
  );
}
