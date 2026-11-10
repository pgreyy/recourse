import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';

// ---------- API ----------

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public body: unknown) {
    super(message);
  }
}

export async function api<T = any>(path: string, init?: { method?: string; body?: unknown; signal?: AbortSignal }): Promise<T> {
  const r = await fetch(path, {
    method: init?.method ?? (init?.body ? 'POST' : 'GET'),
    headers: { accept: 'application/json', ...(init?.body !== undefined ? { 'content-type': 'application/json' } : {}) },
    body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
    signal: init?.signal,
  });
  const j: any = await r.json().catch(() => null);
  if (!r.ok) throw new ApiError(r.status, j?.name ?? `HTTP_${r.status}`, j?.message ?? `Request failed (HTTP ${r.status})`, j);
  return j as T;
}

/** Load once (and again when `deps` change). `reload` refetches without clearing what is shown. */
export function useLoad<T>(fn: (signal: AbortSignal) => Promise<T>, deps: unknown[]) {
  const [state, setState] = useState<{ data?: T; error?: Error; loading: boolean }>({ loading: true });
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const run = useCallback((keep: boolean) => {
    const ac = new AbortController();
    setState((s) => ({ data: keep ? s.data : undefined, loading: true }));
    fnRef
      .current(ac.signal)
      .then((data) => !ac.signal.aborted && setState({ data, loading: false }))
      .catch((error) => !ac.signal.aborted && setState((s) => ({ data: keep ? s.data : undefined, error, loading: false })));
    return () => ac.abort();
  }, []);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => run(false), deps);
  return { ...state, reload: () => run(true) };
}

// ---------- router (paths under /app) ----------

const listeners = new Set<() => void>();
const notify = () => listeners.forEach((l) => l());
window.addEventListener('popstate', notify);

export function navigate(to: string) {
  history.pushState(null, '', to.startsWith('/app') ? to : `/app${to}`);
  notify();
  window.scrollTo(0, 0);
}

export function useLocation() {
  const href = useSyncExternalStore(
    (l) => (listeners.add(l), () => listeners.delete(l)),
    () => location.pathname + location.search,
  );
  const url = new URL(href, location.origin);
  return { path: url.pathname.replace(/^\/app/, '') || '/', query: url.searchParams };
}

export function Link({ to, children, className, current }: { to: string; children: ReactNode; className?: string; current?: boolean }) {
  return (
    <a
      href={`/app${to}`}
      className={className}
      aria-current={current ? 'page' : undefined}
      onClick={(e) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
        e.preventDefault();
        navigate(to);
      }}
    >
      {children}
    </a>
  );
}

// ---------- formatting ----------

export type Money = { value: string; currency: string };
export const money = (m?: Money | null) => (m ? `${Number(m.value).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${m.currency}` : '—');
export const moneyList = (ms?: Money[] | null) => (ms && ms.length ? ms.map(money).join(' + ') : '0.00');
export const when = (d?: string | null) =>
  d ? new Date(d).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'UTC' }) + ' UTC' : '—';
export const short = (h?: string | null, n = 12) => (h ? (h.length > n + 3 ? `${h.slice(0, n)}…` : h) : '—');
/** Show enough of an email to recognise it, not the whole address. */
export const maskEmail = (e?: string | null) => (e ? e.replace(/^([^@]{0,3})[^@]*@/, '$1…@') : '—');
export const pct = (x?: number | null) => (x === null || x === undefined ? '—' : `${(x * 100).toFixed(1)}%`);

// ---------- small components ----------

export type Tone = 'ok' | 'warn' | 'bad' | 'neutral' | 'accent';

export function Status({ tone, children }: { tone: Tone; children: ReactNode }) {
  return <span className={`status ${tone}`}>{children}</span>;
}

/** Who decided this: Code (deterministic) or AI (the model). */
export function Who({ by }: { by: 'code' | 'ai' }) {
  return (
    <span className={`who ${by}`} title={by === 'ai' ? 'Proposed by the AI model' : 'Computed by code'}>
      {by === 'ai' ? 'AI' : 'Code'}
    </span>
  );
}

export function Id({ children, title }: { children: ReactNode; title?: string }) {
  return (
    <span className="idv" title={title}>
      {children}
    </span>
  );
}

export function ErrorNote({ error }: { error?: Error | null }) {
  if (!error) return null;
  return (
    <div className="notice bad" role="alert">
      {error instanceof ApiError && error.code === 'DEMO_LIMIT' ? (
        <>{error.message}</>
      ) : (
        <>
          <strong>{error instanceof ApiError ? error.code : 'Error'}:</strong> {error.message}
        </>
      )}
    </div>
  );
}

const VERDICT_TONE: Record<string, Tone> = {
  AGENT_FAULT: 'bad',
  MERCHANT_FAULT: 'warn',
  BUYER_REMORSE: 'neutral',
  THIRD_PARTY_FAULT: 'neutral',
  INCONCLUSIVE: 'warn',
};
export const verdictLabel = (v?: string | null) => (v ? v.replace(/_/g, ' ').toLowerCase().replace(/^\w/, (c) => c.toUpperCase()) : 'Not assessed');
export function Verdict({ v }: { v?: string | null }) {
  return <Status tone={v ? VERDICT_TONE[v] ?? 'neutral' : 'neutral'}>{verdictLabel(v)}</Status>;
}

const SETTLEMENT: Record<string, [Tone, string]> = {
  OPEN: ['neutral', 'Open'],
  BUYER_REFUNDED: ['warn', 'Buyer refunded'],
  AWAITING_CONFIRMATION: ['warn', 'Pending confirmation'],
  INVOICED: ['warn', 'Invoiced'],
  AWAITING_PAYPAL: ['warn', 'Awaiting PayPal'],
  RECOVERED: ['ok', 'Recovered'],
  COMPLETED: ['ok', 'Completed'],
  FAILED: ['bad', 'Failed'],
  NO_ACTION: ['neutral', 'No charge'],
};
export function SettlementStatus({ s }: { s?: string | null }) {
  if (!s) return <span className="muted">No settlement</span>;
  const [tone, label] = SETTLEMENT[s] ?? ['neutral', s];
  return <Status tone={tone}>{label}</Status>;
}

const POLICY: Record<string, [Tone, string]> = { normal: ['ok', 'Normal'], 'step-up': ['warn', 'Step-up'], suspended: ['bad', 'Suspended'] };
export function Policy({ p }: { p?: string | null }) {
  const [tone, label] = POLICY[p ?? ''] ?? ['neutral', p ?? 'Unknown'];
  return <Status tone={tone}>{label}</Status>;
}

export function CheckMark({ ok, label }: { ok: boolean | null; label?: string }) {
  if (ok === null) return <Status tone="neutral">{label ?? 'Not checked'}</Status>;
  return <Status tone={ok ? 'ok' : 'bad'}>{label ?? (ok ? 'Pass' : 'Fail')}</Status>;
}

export function Modal({ title, children, onClose }: { title: string; children: ReactNode; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    ref.current?.querySelector<HTMLElement>('input, button')?.focus();
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      prev?.focus();
    };
  }, [onClose]);
  return (
    <div className="modal-back" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title" ref={ref}>
        <h2 id="modal-title" style={{ marginBottom: 14 }}>
          {title}
        </h2>
        {children}
      </div>
    </div>
  );
}
