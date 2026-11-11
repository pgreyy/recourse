import type { ReactNode } from 'react';
import { api, Link, useLoad, Notice, BackButton } from '../lib';

type Login = { email: string; password: string | null } | null;
type JudgeInfo = { buyer: Login; operator: Login; limits: { ai_calls: { limit: number; used: number; remaining: number }; agent_runs_per_ip_per_hour: number } };

const INSTRUCTIONS = 'Refundable hotel in Lisbon, Nov 20 to 22, under $400 total, 4 stars or more';

export function Judges() {
  const j = useLoad(() => api<JudgeInfo>('/console/judges'), []);
  return (
    <main className="page" style={{ maxWidth: 980 }}>
      <div className="page-head">
        <div>
          <BackButton />
          <h1>Demo guide (for judges)</h1>
          <p>
            Recourse is the liability layer for agentic commerce. A buyer signs instructions, an AI agent shops under them, and every decision the agent makes is
            recorded and anchored in the PayPal order. When the purchase goes wrong, Recourse works out who is responsible and the agent's operator pays,
            automatically, on PayPal, within a liability agreement it signed with caps.
          </p>
        </div>
      </div>

      <div className="stack" style={{ gap: 18 }}>
        <section className="card card-pad stack" aria-labelledby="logins">
          <h2 id="logins">Before you start</h2>
          <div className="grid2">
            <LoginCard title="Sandbox buyer (approves instructions, opens the dispute)" l={j.data?.buyer} />
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
              <Link to="/buyer">Buyer</Link>: keep the text <q>{INSTRUCTIONS}</q>, enter any email, <b>Compile rules</b>. Compare your words with the compiled rules, then{' '}
              <b>Approve with PayPal</b> and log in as the sandbox buyer. You come back to signed, active instructions.
            </>,
            <>
              <Link to="/agent">Agent run</Link>: pick <b>Wayfare Booker v1.3 (fast)</b> and your instructions, <b>Run agent</b>. Watch the timeline: the refundable rate
              at Casa Lumen is sold out, Tidewell Stays suggests its <b>Flexible Saver</b> rate (no refund policy given), the agent accepts it, then a{' '}
              <b>Firewall warning</b> and <b>Checkout went ahead despite the warning</b>. It ends with the PayPal order and capture ids, the booking confirmation and{' '}
              <b>Decision trail anchored in the PayPal order</b>.
            </>,
            <>
              <b>Open the receipt</b> (on the same screen): the differences show the missing refund policy and the description's <q>Non-refundable after booking</q>.{' '}
              <b>Request cancellation</b>: Tidewell Stays refuses. Then <b>Report an issue</b>: <q>I asked for a refundable hotel. This rate can't be cancelled.</q>
            </>,
            <>
              <Link to="/console?page=cases">Console, Cases</Link>: open the new case, <b>Assess</b> (about 30 seconds). Read the three columns: what was authorised,
              what happened (warned at one step, went ahead at the next, and the refundable rate that was available, from the frozen catalog snapshot), and the
              conclusion with <b>Why not the merchant or the buyer?</b>, each line tagged Code or AI.
            </>,
            <>
              <b>Approve decision</b> (your name and email). Open <b>Operator's view of this decision</b> and <b>Accept</b> as Wayfare Agents, then back on the case{' '}
              <b>Run settlement</b>: the buyer is refunded and the operator's saved PayPal is charged, with real PayPal ids. Press <b>Check with PayPal</b> until both
              say Confirmed: only then does it say Recovered, and <b>Who paid what</b> appears.
            </>,
            <>
              <Link to="/console?page=agents">Agents and operators</Link>: Wayfare Booker v1.3 is now on <b>Step-up</b> (recent confirmed agent fault): its next booking
              needs the buyer's approval.
            </>,
          ]}
        />

        <Scenario
          id="b"
          title="Scenario B: the careful agent, and no case (about 4 minutes)"
          steps={[
            <>
              <Link to="/buyer">Buyer</Link>: compile and approve new instructions with the same text (one booking per set of instructions).
            </>,
            <>
              <Link to="/agent">Agent run</Link>: pick <b>Wayfare Booker v2.0 (careful)</b>. It refuses the Flexible Saver because it has no refund policy, and books{' '}
              <b>Hotel Ribeira Alta, refundable, 380.00 total</b> (taxes included); the firewall passes.
            </>,
            <>
              <b>Open the receipt</b>: Compliant, no differences. Optionally <b>Request cancellation</b>: the rate is refundable, so Tidewell Stays cancels it and refunds
              you on PayPal. No case is needed.
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
              <b>Operator onboarding</b> (<Link to="/operator">open it</Link>): Drift Commerce has no accepted agreement, so its agent, Drift Booker, needs the
              buyer's approval at PayPal for every booking.
            </li>
            <li>
              <b>Scorecard</b> (<Link to="/console?page=scorecard">open it</Link>): an internal, labelled set of retail and travel cases with known answers, run
              through the same assessment pipeline, including how often it wrongly blames an agent. It shows behaviour on known cases, not production accuracy.
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
