import type { AgAiChatMessage, AgAiChatSession, AgAiHarness, AgAiRunStatus } from 'ag-studio';
import { Fragment, useEffect, useRef, useState, type ReactNode } from 'react';
import { CLERK_STARTERS, clerkToolDisplay, ProposalCard } from './clerk';

/**
 * The Clerk's chat surface. The conversation, the turn loop and tool execution all belong to the
 * AG Studio harness (createAiHarness + directLlmRunner); this component only renders a session's
 * messages and sends the reader's questions. The console stays in view mode.
 */
export function ClerkPanel({ harness, onClose }: { harness: AgAiHarness | null; onClose: () => void }) {
  const [session, setSession] = useState<AgAiChatSession | null>(null);
  const [messages, setMessages] = useState<ReadonlyArray<AgAiChatMessage>>([]);
  const [status, setStatus] = useState<AgAiRunStatus>('idle');
  const [text, setText] = useState('');
  const endRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!session) return;
    const sync = () => {
      setMessages(session.messages);
      setStatus(session.status);
    };
    session.addEventListener('changed', sync);
    sync();
    return () => session.removeEventListener('changed', sync);
  }, [session]);
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' });
  }, [messages, status]);
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  async function ask(q: string) {
    const question = q.trim();
    if (!question || !harness || status === 'running') return;
    setText('');
    let s = session;
    if (!s) {
      s = await harness.createThread({ agentId: 'clerk', title: question.slice(0, 60) });
      setSession(s);
    }
    s.sendMessage(question);
  }
  async function reset() {
    session?.cancel();
    setSession(null);
    setMessages([]);
    setStatus('idle');
    inputRef.current?.focus();
  }

  return (
    <aside className="clerk" aria-labelledby="clerk-title">
      <div className="clerk-head">
        <div>
          <h2 id="clerk-title">The Clerk</h2>
          <p className="small muted">Read-only. It can propose; only the buttons on a case act.</p>
        </div>
        <div className="row" style={{ gap: 6 }}>
          {messages.length > 0 && (
            <button className="btn small secondary" onClick={reset}>
              New question
            </button>
          )}
          <button className="btn small secondary" onClick={onClose} aria-label="Close the Clerk">
            Close
          </button>
        </div>
      </div>
      <div className="clerk-body" aria-live="polite">
        {messages.length === 0 && (
          <div className="stack" style={{ gap: 8 }}>
            <p className="muted small">Ask about cases, rulings, settlements, reputation or the scorecard. Every answer comes from Recourse data through read-only tools.</p>
            {CLERK_STARTERS.map((s) => (
              <button key={s.label} className="starter" onClick={() => ask(s.prompt)} disabled={!harness}>
                {s.prompt}
              </button>
            ))}
          </div>
        )}
        {messages.map((m) => (
          <div key={m.id} className={`msg ${m.role}`}>
            {m.parts.map((p, i) => (
              <Fragment key={i}>
                {p.type === 'text' && (m.role === 'user' ? <p>{p.text}</p> : <Markdown text={p.text} />)}
                {p.type === 'tool_call' && <ToolStep call={p.toolCall} />}
              </Fragment>
            ))}
          </div>
        ))}
        {status === 'running' && <p className="small muted working">The Clerk is reading the records…</p>}
        {status === 'error' && <p className="small error">The Clerk could not finish. Try again.</p>}
        <div ref={endRef} />
      </div>
      <form
        className="clerk-input"
        onSubmit={(e) => {
          e.preventDefault();
          ask(text);
        }}
      >
        <label htmlFor="clerk-q" className="sr-only">
          Ask the Clerk
        </label>
        <textarea
          id="clerk-q"
          ref={inputRef}
          rows={2}
          value={text}
          placeholder="Ask the Clerk…"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              ask(text);
            }
          }}
        />
        <button className="btn" disabled={!text.trim() || status === 'running' || !harness}>
          Ask
        </button>
      </form>
    </aside>
  );
}

function ToolStep({ call }: { call: { name: string; status: string; args: any; result?: any } }) {
  const d = (clerkToolDisplay as any)[call.name];
  const label = d ? d.label({ args: call.args, result: call.result }) : { text: call.name };
  const state = call.status === 'complete' ? (call.result?.success === false ? 'failed' : 'done') : call.status === 'error' ? 'failed' : call.status === 'cancelled' ? 'cancelled' : 'running';
  if (call.name === 'propose_action' && state === 'done') return <ProposalCard args={call.args} result={call.result} />;
  return (
    <div className={`step ${state}`}>
      <span className="step-mark" aria-hidden="true" />
      <span>{label.text}</span>
      {label.pill && <span className="pill">{label.pill}</span>}
      <span className="sr-only">({state})</span>
    </div>
  );
}

/** Tiny, safe markdown: paragraphs, bullet lists, **bold** and `code`. No HTML is injected. */
function Markdown({ text }: { text: string }) {
  // Group lines into paragraphs and bullet lists; blank lines separate blocks.
  const out: ReactNode[] = [];
  let para: string[] = [];
  let list: string[] = [];
  const flush = () => {
    if (para.length) out.push(<p key={out.length}>{para.map((l, j) => <Fragment key={j}>{j > 0 && <br />}{inline(l)}</Fragment>)}</p>);
    if (list.length) out.push(<ul key={out.length}>{list.map((l, j) => <li key={j}>{inline(l)}</li>)}</ul>);
    para = [];
    list = [];
  };
  for (const line of text.trim().split('\n')) {
    const bullet = line.match(/^\s*(?:[-*]|\d+\.)\s+(.*)$/);
    if (!line.trim()) flush();
    else if (bullet) {
      if (para.length) flush();
      list.push(bullet[1]);
    } else {
      if (list.length) flush();
      para.push(line);
    }
  }
  flush();
  return <>{out}</>;
}

function inline(s: string): ReactNode[] {
  return s.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).map((t, i) =>
    t.startsWith('**') && t.endsWith('**') ? <strong key={i}>{t.slice(2, -2)}</strong> : t.startsWith('`') && t.endsWith('`') ? <code key={i}>{t.slice(1, -1)}</code> : t,
  );
}
