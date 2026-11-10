import type { ReactNode } from 'react';
import { api, Link, useLoad, Notice } from '../lib';

type Login = { email: string; password: string | null } | null;
type JudgeInfo = { buyer: Login; operator: Login; limits: { ai_calls: { limit: number; used: number; remaining: number }; agent_runs_per_ip_per_hour: number } };

const MANDATE = "Running shoes, US men's 10, under $120, Kestrel or Sorin, by Friday";

export function Judges() {
  const j = useLoad(() => api<JudgeInfo>('/console/judges'), []);
  return (
    <main className="page" style={{ maxWidth: 980 }}>
      <div className="page-head">
        <div>
          <h1>For judges</h1>
          <p>
            Recourse is the liability layer for agentic commerce. A buyer signs a mandate, an AI agent shops under it, and every decision the agent makes is
            recorded and anchored in the PayPal order. When the purchase goes wrong, Recourse works out who is responsible and the agent's operator pays,
            automatically, on PayPal, within a liability agreement it signed with caps.
          </p>
        </div>
      </div>

      <div className="stack" style={{ gap: 18 }}>
        <section className="card card-pad stack" aria-labelledby="logins">
          <h2 id="logins">Before you start</h2>
          <div className="grid2">
            <LoginCard title="Sandbox buyer (approves mandates, opens the dispute)" l={j.data?.buyer} />
            <LoginCard title="Sandbox operator (already onboarded)" l={j.data?.operator} />
          </div>
          <Notice id="judges-sandbox" summary="The PayPal pages are real PayPal, in its sandbox. No real money moves.">
            You are sent to sandbox.paypal.com: log in there with the sandbox accounts above, never with a real PayPal account.
          </Notice>
          {j.data && (
            <p className="small muted">
              Demo limits, to protect the AI budget: {j.data.limits.ai_calls.limit} AI calls per hour for everyone together ({j.data.limits.ai_calls.remaining} left
              right now) and {j.data.limits.agent_runs_per_ip_per_hour} agent runs per hour per visitor. If you hit one, the screen says so; try again later.
            </p>
          )}
        </section>

        <Scenario
          id="a"
          title="Scenario A: the agent's fault, recovered from its operator (about 6 minutes)"
          steps={[
            <>
              <Link to="/buyer">Buyer</Link>: keep the text <q>{MANDATE}</q>, enter any email, <b>Compile rules</b>. Compare your words with the compiled rules, then{' '}
              <b>Approve with PayPal</b> and log in as the sandbox buyer. You come back to a signed, active mandate.
            </>,
            <>
              <Link to="/agent">Agent run</Link>: pick <b>Acme Shopper v1.3 (fast)</b> and your mandate, <b>Run agent</b>. Watch the timeline: the cart is out of stock,{' '}
              the merchant suggests a substitute (size 10 with no size system), the agent accepts it, then a <b>Firewall warning</b> and <b>Checkout went ahead despite the warning</b>. It ends with the PayPal
              order and capture ids and <b>Decision trail anchored in the PayPal order</b>.
            </>,
            <>
              <b>Open the receipt</b> (on the same screen) and <b>Report an issue</b>: <q>These are UK sizing, I asked for US 10.</q>
            </>,
            <>
              <Link to="/console?page=cases">Console, Cases</Link>: open the new case, <b>Assess</b> (about 30 seconds). Read the three columns: what was
              authorised, what happened (warned at one step, proceeded at the next, the in-stock compliant alternative from the frozen catalog snapshot), and the
              conclusion, each check tagged Code or AI.
            </>,
            <>
              <b>Approve ruling</b> (your name and email), then <b>Operator accepts</b>, then <b>Run settlement</b> in the settlement panel: the buyer is refunded
              and the operator's saved PayPal is charged, with real PayPal ids. Press <b>Check with PayPal</b> until both say Confirmed: only then does it say
              Recovered.
            </>,
            <>
              <Link to="/console?page=agents">Agents and operators</Link>: Acme Shopper v1.3 is now on <b>Step-up</b> (recent confirmed agent fault): its next
              purchase needs the buyer's approval.
            </>,
          ]}
        />

        <Scenario
          id="b"
          title="Scenario B: a PayPal dispute that is buyer's remorse (about 10 minutes)"
          steps={[
            <>
              <Link to="/buyer">Buyer</Link>: compile and approve a new mandate (one order per mandate; the same text works).
            </>,
            <>
              <Link to="/agent">Agent run</Link>: pick <b>Acme Shopper v2.0 (careful)</b>. It buys the compliant Sorin Cloudline US 10; the firewall passes.
            </>,
            <>
              Open <a href="https://www.sandbox.paypal.com" target="_blank" rel="noreferrer">sandbox.paypal.com</a> as the sandbox buyer, find the Stride &amp; Co
              payment in Activity, <b>Report a problem</b> and open a dispute (for example, item not as described: <q>they arrived as ordered but don't feel
              right</q>).
            </>,
            <>
              PayPal's webhook opens a case on its own: refresh <Link to="/console?page=cases">Cases</Link>. <b>Assess</b>: buyer's remorse, no clause broken,
              citing the compliant purchase and your own words in the dispute.
            </>,
            <>
              <b>Approve ruling</b>, then <b>Run settlement</b>: Recourse escalates the dispute and, once PayPal offers it (a few minutes later), <b>Run
              settlement</b> again files a two page evidence PDF with PayPal. The panel shows PayPal's live dispute status; the sandbox does not decide disputes, so
              it stays under review.
            </>,
          ]}
        />

        <section className="card card-pad stack" aria-labelledby="more">
          <h2 id="more">Also worth a look</h2>
          <ul style={{ margin: 0, paddingLeft: 20 }} className="stack">
            <li>
              <b>The Clerk</b> (<b>Ask the Clerk</b> in the sidebar): ask <q>Which agent version caused the most recovered losses this week?</q> Then ask it to
              refund a case: it cannot move money, and it states refunds and charges only from the settlement records, with their PayPal ids.
            </li>
            <li>
              <b>Operator onboarding</b> (<Link to="/operator">open it</Link>): Drift Commerce has no accepted agreement, so its agent needs the buyer's approval on
              every purchase.
            </li>
            <li>
              <b>Scorecard</b> (<Link to="/console?page=scorecard">open it</Link>): the assessment pipeline on 24 fixed cases, including how often it wrongly blames an
              agent (0 so far).
            </li>
          </ul>
        </section>
      </div>
    </main>
  );
}

function LoginCard({ title, l }: { title: string; l?: Login }) {
  return (
    <div className="kpi" style={{ gap: 6 }}>
      <span className="label">{title}</span>
      {l ? (
        <dl className="kv small">
          <dt>Email</dt>
          <dd className="mono">{l.email}</dd>
          <dt>Password</dt>
          <dd className="mono">{l.password ?? 'in the Devpost testing instructions'}</dd>
        </dl>
      ) : (
        <span className="small muted">In the Devpost testing instructions.</span>
      )}
    </div>
  );
}

function Scenario({ id, title, steps }: { id: string; title: string; steps: ReactNode[] }) {
  return (
    <section className="card card-pad stack" aria-labelledby={`sc-${id}`}>
      <h2 id={`sc-${id}`}>{title}</h2>
      <ol className="stack" style={{ margin: 0, paddingLeft: 22, gap: 10 }}>
        {steps.map((s, i) => (
          <li key={i}>{s}</li>
        ))}
      </ol>
    </section>
  );
}
