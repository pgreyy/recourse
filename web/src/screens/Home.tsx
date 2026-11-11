import { useEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { Icons } from '../icons';
import { api, Link, useLoad, type Money } from '../lib';
import './home.css';

type HomeData = {
  numbers: {
    recovered_confirmed: { count: number; amount: Money[] };
    cases_decided: number;
    operators_covered: number;
    wrongly_blamed_in_testing: { count: number; cases: number; run_id: string } | null;
  };
  story: null | {
    case_ref: string | null;
    asked: string | null;
    booked: string | null;
    alternative: { what: string; total: string } | null;
    currency: string;
    buyer_refunded: string;
    merchant_loss: string;
    operator_charged: string;
  };
  links: { video_url: string | null; repo_url: string | null };
};

/** The demo's own scenario, used until a settled case exists (the figures this demo settles to). */
const DEMO_STORY = {
  case_ref: null as string | null,
  asked: 'Refundable hotel in Lisbon, under $400',
  booked: 'Flexible Saver, non-refundable',
  alternative: { what: 'A refundable room', total: '380.00' },
  currency: 'USD',
  buyer_refunded: '340.00',
  merchant_loss: '0.00',
  operator_charged: '352.80',
};

const reducedMotion = () => typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

/** True once the element has been on screen (once). Without IntersectionObserver, true at once. */
function useSeen<T extends Element>(): [RefObject<T | null>, boolean] {
  const ref = useRef<T>(null);
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || seen) return;
    if (!('IntersectionObserver' in window) || reducedMotion()) return setSeen(true);
    const io = new IntersectionObserver(
      (es) => {
        if (es.some((e) => e.isIntersecting)) {
          setSeen(true);
          io.disconnect();
        }
      },
      { threshold: 0.35 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [seen]);
  return [ref, seen];
}

/** Counts from 0 to `to` once `run` is true: fast start, soft landing; instant when motion is reduced. */
function useCount(to: number, run: boolean, ms = 900) {
  const [v, setV] = useState(reducedMotion() ? to : 0);
  useEffect(() => {
    if (!run) return;
    if (reducedMotion()) return setV(to);
    let raf = 0;
    const t0 = performance.now();
    const tick = (t: number) => {
      const p = Math.min(1, (t - t0) / ms);
      setV(to * (1 - Math.pow(2, -10 * p)) * (p < 1 ? 1 : 1 / (1 - Math.pow(2, -10))));
      if (p < 1) raf = requestAnimationFrame(tick);
      else setV(to);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [to, run, ms]);
  return v;
}

const fmt = (n: number, decimals = 2) => n.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
const dollars = (v: string, ccy: string) => (ccy === 'USD' ? `$${Number(v) % 1 === 0 ? fmt(Number(v), 0) : fmt(Number(v))}` : `${fmt(Number(v))} ${ccy}`);

// ---------- the case card ----------

/** The story's five beats and when each lands (ms from start). Rests on the last beat. */
const BEATS = [300, 1900, 4100, 6200, 9000];
const FINAL = BEATS.length;

function CaseCard({ story, recorded }: { story: typeof DEMO_STORY; recorded: boolean }) {
  const [step, setStep] = useState(reducedMotion() ? FINAL : 0);
  const [run, setRun] = useState(0);
  useEffect(() => {
    if (reducedMotion()) {
      setStep(FINAL);
      return;
    }
    setStep(0);
    const timers = BEATS.map((at, i) => window.setTimeout(() => setStep(i + 1), at));
    return () => timers.forEach(clearTimeout);
  }, [run]);
  const at = (n: number) => (step >= n ? 'on' : 'off');
  const money = (v: string) => `${v} ${story.currency}`;
  return (
    <figure className="casecard" aria-label="An example case, played as a story">
      <div className="cc-head">
        <span className="cc-ref">{story.case_ref ?? 'Example case'}</span>
        <button type="button" className="cc-replay" onClick={() => setRun((r) => r + 1)} disabled={step < FINAL} aria-label="Replay the case">
          Replay
        </button>
      </div>
      <ol className="cc-rows">
        <li className={`cc-row ${at(1)}`}>
          <span className="cc-k">Asked</span>
          <span className="cc-v">{story.asked}</span>
        </li>
        <li className={`cc-row ${at(2)}`}>
          <span className="cc-k">Booked</span>
          <span className="cc-v">
            {story.booked}
            <span className={`stamp bad press ${at(2)}`}>Mismatch</span>
          </span>
        </li>
        <li className={`cc-row ${at(3)}`}>
          <span className="cc-k">Decision</span>
          <span className="cc-v">
            <span className={`stamp bad press ${at(3)}`}>Agent fault</span>
            {story.alternative && (
              <span className="cc-note">
                {story.alternative.what} for {dollars(story.alternative.total, story.currency)} total was available
              </span>
            )}
          </span>
        </li>
        <li className={`cc-row ${at(4)}`}>
          <span className="cc-k">Who paid what</span>
          <table className="cc-pay">
            <tbody>
              <PayRow label="Buyer" value={`+${story.buyer_refunded}`} note="refunded" run={step >= 4} delay={0} />
              <PayRow label="Merchant" value={story.merchant_loss} note="loss after recovery" run={step >= 4} delay={350} />
              <PayRow label="Operator" value={`−${story.operator_charged}`} note="charged" run={step >= 4} delay={700} />
            </tbody>
          </table>
        </li>
        <li className={`cc-row ${at(5)}`}>
          <span className="cc-k">Settlement</span>
          <span className="cc-v">
            <span className={`stamp ok press ${at(5)}`}>Recovered, confirmed by PayPal</span>
          </span>
        </li>
      </ol>
      <figcaption className="cc-cap">
        {recorded ? 'From a recorded PayPal sandbox run' : "This demo's scenario, with the figures it settles to"}
        <span className="sr-only">: {[story.asked, story.booked, 'agent fault', `buyer refunded ${money(story.buyer_refunded)}`, `merchant loss ${money(story.merchant_loss)}`, `operator charged ${money(story.operator_charged)}`, 'recovered, confirmed by PayPal'].join('; ')}</span>
      </figcaption>
    </figure>
  );
}

function PayRow({ label, value, note, run, delay }: { label: string; value: string; note: string; run: boolean; delay: number }) {
  const [go, setGo] = useState(false);
  useEffect(() => {
    if (!run) return setGo(false);
    const t = window.setTimeout(() => setGo(true), reducedMotion() ? 0 : delay);
    return () => clearTimeout(t);
  }, [run, delay]);
  const target = Math.abs(Number(value.replace(/[^\d.]/g, '')));
  const n = useCount(target, go, 700);
  const sign = value.startsWith('+') ? '+' : value.startsWith('−') ? '−' : '';
  return (
    <tr className={go ? 'on' : 'off'}>
      <th scope="row">{label}</th>
      <td className={`amt ${sign === '+' ? 'in' : sign === '−' ? 'out' : ''}`}>
        {sign}
        {fmt(go ? n : 0)}
      </td>
      <td className="note">{note}</td>
    </tr>
  );
}

// ---------- numbers ----------

function Figure({ value, decimals = 0, suffix, label, seen }: { value: number; decimals?: number; suffix?: string; label: ReactNode; seen: boolean }) {
  const n = useCount(value, seen, 1100);
  return (
    <div className="fig">
      <div className="fig-v">
        {fmt(n, decimals)}
        {suffix && <span className="fig-u"> {suffix}</span>}
      </div>
      <div className="fig-l">{label}</div>
    </div>
  );
}

function Numbers({ d }: { d: HomeData | null }) {
  const [ref, seen] = useSeen<HTMLDivElement>();
  const usd = d?.numbers.recovered_confirmed.amount.find((m) => m.currency === 'USD');
  const wrong = d?.numbers.wrongly_blamed_in_testing;
  return (
    <section className="figures" aria-label="Live figures" ref={ref}>
      <Figure seen={seen && Boolean(d)} value={Number(usd?.value ?? 0)} decimals={2} suffix="USD" label="Recovered from operators, confirmed by PayPal" />
      <Figure seen={seen && Boolean(d)} value={d?.numbers.cases_decided ?? 0} label="Cases decided" />
      <Figure seen={seen && Boolean(d)} value={d?.numbers.operators_covered ?? 0} label="Operators covered" />
      <Figure
        seen={seen && Boolean(d)}
        value={wrong?.count ?? 0}
        label={wrong ? `Agents wrongly blamed in testing (${wrong.cases} labelled cases)` : 'Agents wrongly blamed in testing'}
      />
    </section>
  );
}

// ---------- how it works ----------

const STEPS = [
  { to: '/operator', icon: Icons.operator, title: 'Operator signs', text: 'The company behind the agent accepts a capped liability agreement and saves a PayPal payment method for approved recoveries.' },
  { to: '/buyer', icon: Icons.buyer, title: 'Buyer gives instructions', text: 'The buyer writes what the agent may book in plain English and approves the compiled rules once with PayPal.' },
  { to: '/agent', icon: Icons.agent, title: 'Agent books', text: 'Every step is recorded, a firewall checks the booking against the instructions, and the trail is anchored in the PayPal order.' },
  { to: '/console', icon: Icons.settlements, title: 'Recourse settles', text: 'If the agent was at fault, a person approves the decision and Recourse refunds the buyer and charges the operator on PayPal.' },
];

function HowItWorks() {
  const [ref, seen] = useSeen<HTMLOListElement>();
  return (
    <section className="how" aria-labelledby="how-title">
      <h2 id="how-title" className="sec-title">
        How it works
      </h2>
      <ol className={`ledgerline ${seen ? 'drawn' : ''}`} ref={ref}>
        {STEPS.map((s, i) => (
          <li key={s.to} style={{ ['--i' as string]: i }}>
            <span className="node" aria-hidden="true">
              {i + 1}
            </span>
            <span className="ll-icon" aria-hidden="true">
              {s.icon()}
            </span>
            <Link to={s.to} className="ll-title">
              {s.title}
            </Link>
            <p>{s.text}</p>
          </li>
        ))}
      </ol>
    </section>
  );
}

// ---------- page ----------

export function Home() {
  const { data, loading } = useLoad<HomeData>((signal) => api('/console/home', { signal }), []);
  const d = data ?? null;
  const real = d?.story && d.story.asked && d.story.booked ? d.story : null;
  const story: typeof DEMO_STORY = real ? { ...real, asked: real.asked!, booked: real.booked!, alternative: real.alternative ?? DEMO_STORY.alternative } : DEMO_STORY;
  return (
    <main className="page home">
      <section className="hero">
        <div className="hero-copy">
          <p className="hero-line">The liability layer for agentic commerce</p>
          <h1 className="hero-title">Agents can transact. Someone must own the outcome.</h1>
          <p className="hero-sub">
            When an AI agent books the wrong thing, Recourse makes the company behind it pay, under a capped agreement it signed in advance, and settles it on
            PayPal.
          </p>
          <div className="hero-actions">
            <Link to="/operator" className="btn">
              Start the walkthrough
            </Link>
            <Link to="/judges" className="btn secondary">
              Demo guide (for judges)
            </Link>
            {d?.links.video_url && (
              <a className="btn secondary" href={d.links.video_url} target="_blank" rel="noreferrer">
                Watch the demo (3 min)
              </a>
            )}
          </div>
        </div>
        {/* Wait for the API so the card plays once, with the right figures. */}
        {!loading ? <CaseCard key={story.case_ref ?? 'demo'} story={story} recorded={Boolean(real)} /> : <div className="casecard placeholder" aria-hidden="true" />}
      </section>

      <Numbers d={d} />

      <HowItWorks />

      <section className="trust" aria-labelledby="trust-title">
        <h2 id="trust-title" className="sec-title">
          The order of trust
        </h2>
        <ol className="trust-chain">
          {['AI proposes', 'Code verifies', 'A person approves', 'PayPal executes'].map((t) => (
            <li key={t}>
              <span className="stamp neutral">{t}</span>
            </li>
          ))}
        </ol>
      </section>

      <section className="why" aria-labelledby="why-title">
        <h2 id="why-title" className="sec-title">
          Why operators sign
        </h2>
        <div className="why-pair">
          <div className="why-card">
            <span className="stamp ok">Covered</span>
            <p className="why-head">Books normally</p>
            <p>Agents under an accepted agreement check out with the buyer's saved PayPal, under normal checkout policy.</p>
          </div>
          <div className="why-card">
            <span className="stamp bad">Not covered</span>
            <p className="why-head">Buyer approval every time</p>
            <p>Agents without an agreement can still book, but every booking waits for the buyer to approve it at PayPal.</p>
          </div>
        </div>
      </section>

      <footer className="home-foot">
        <p>Built on the PayPal sandbox for the PayPal AI Hackathon 2026.</p>
        <nav aria-label="More">
          <Link to="/judges">Demo guide</Link>
          {d?.links.repo_url && (
            <a href={d.links.repo_url} target="_blank" rel="noreferrer">
              GitHub
            </a>
          )}
        </nav>
      </footer>
    </main>
  );
}
