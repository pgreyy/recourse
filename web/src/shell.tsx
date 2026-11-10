import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Mark } from './brand';
import { Icons } from './icons';
import { Link, navigate, useLocation } from './lib';

const STORE = 'recourse.sidebar';
const read = () => {
  try {
    return localStorage.getItem(STORE) === 'collapsed';
  } catch {
    return false;
  }
};
const write = (collapsed: boolean) => {
  try {
    localStorage.setItem(STORE, collapsed ? 'collapsed' : 'expanded');
  } catch {
    /* storage unavailable: the state lasts for this page only */
  }
};

type Item = { key: string; to: string; label: string; icon: () => ReactNode; step?: string; count?: number | null };

const WALKTHROUGH: Item[] = [
  { key: '/operator', to: '/operator', label: 'Operator', icon: Icons.operator, step: '1' },
  { key: '/buyer', to: '/buyer', label: 'Buyer', icon: Icons.buyer, step: '2' },
  { key: '/agent', to: '/agent', label: 'Agent run', icon: Icons.agent, step: '3' },
];
const CONSOLE: Array<Item & { page: string }> = [
  { key: 'overview', page: 'overview', to: '/console?page=overview', label: 'Overview', icon: Icons.overview },
  { key: 'cases', page: 'cases', to: '/console?page=cases', label: 'Cases', icon: Icons.cases },
  { key: 'case', page: 'case', to: '/console?page=case', label: 'Case detail', icon: Icons.caseDetail },
  { key: 'agents', page: 'agents', to: '/console?page=agents', label: 'Agents and operators', icon: Icons.agents },
  { key: 'settlements', page: 'settlements', to: '/console?page=settlements', label: 'Settlements', icon: Icons.settlements },
  { key: 'scorecard', page: 'scorecard', to: '/console?page=scorecard', label: 'Scorecard', icon: Icons.scorecard },
];

/** The app shell: one collapsible sidebar (a slide-over drawer under 768 px) and the screen beside it. */
export function Shell({ children }: { children: ReactNode }) {
  const { path, query } = useLocation();
  const section = '/' + (path.split('/')[1] ?? '');
  const consolePage = section === '/console' ? query.get('page') ?? 'overview' : null;
  const [collapsed, setCollapsed] = useState(read);
  const [drawer, setDrawer] = useState(false);
  const [clerkOpen, setClerkOpen] = useState(false);
  const [caseCount, setCaseCount] = useState<number | null>(null);
  const menuBtn = useRef<HTMLButtonElement>(null);
  const sidebar = useRef<HTMLElement>(null);

  const toggle = useCallback(() => {
    setCollapsed((c) => {
      write(!c);
      return !c;
    });
  }, []);

  // Ctrl+B (Cmd+B on a Mac) collapses or expands the sidebar, except while typing in a field.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'b') {
        const t = e.target as HTMLElement | null;
        if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
        e.preventDefault();
        if (window.matchMedia('(max-width: 767px)').matches) setDrawer((d) => !d);
        else toggle();
      }
      if (e.key === 'Escape' && drawer) setDrawer(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [toggle, drawer]);

  // The drawer: focus moves into it when it opens and back to the menu button when it closes.
  const wasOpen = useRef(false);
  useEffect(() => {
    if (drawer) sidebar.current?.querySelector<HTMLElement>('a, button')?.focus();
    else if (wasOpen.current) menuBtn.current?.focus();
    wasOpen.current = drawer;
  }, [drawer]);
  useEffect(() => setDrawer(false), [path, query.toString()]);

  // The console reports whether the Clerk is open and how many cases there are.
  useEffect(() => {
    const onClerk = (e: Event) => setClerkOpen(Boolean((e as CustomEvent).detail));
    const onCount = (e: Event) => setCaseCount((e as CustomEvent).detail as number);
    window.addEventListener('clerk:state', onClerk);
    window.addEventListener('console:cases', onCount);
    return () => {
      window.removeEventListener('clerk:state', onClerk);
      window.removeEventListener('console:cases', onCount);
    };
  }, []);
  const askClerk = () => {
    if (section === '/console') window.dispatchEvent(new CustomEvent('clerk:toggle'));
    else navigate('/console?page=overview&clerk=1');
  };

  const caseParam = query.get('case');
  const item = (it: Item, current: boolean, to = it.to) => (
    <li key={it.key}>
      <Link to={to} className="sb-item" current={current}>
        <span className="sb-ico">
          <it.icon />
          {it.step && <span className="sb-step-badge" aria-hidden="true">{it.step}</span>}
        </span>
        {it.step && <span className="sb-step" aria-hidden="true">{it.step}</span>}
        <span className="sb-label">{it.label}</span>
        {it.count != null && <span className="sb-count">{it.count}</span>}
        <span className="sb-tip" aria-hidden="true">{it.step ? `${it.step} ${it.label}` : it.label}</span>
      </Link>
    </li>
  );

  return (
    <div className={`app${collapsed ? ' collapsed' : ''}${drawer ? ' drawer-open' : ''}`}>
      <header className="mobile-bar">
        <button ref={menuBtn} type="button" className="icon-btn" aria-label="Open the menu" aria-expanded={drawer} aria-controls="sidebar" onClick={() => setDrawer(true)}>
          <Icons.menu />
        </button>
        <Link to="/" className="brand">
          <Mark size={24} />
          <span className="wordmark">Recourse</span>
        </Link>
      </header>
      {drawer && <div className="scrim" onClick={() => setDrawer(false)} aria-hidden="true" />}
      <aside ref={sidebar} id="sidebar" className="sidebar" aria-label="Recourse">
        <div className="sb-top">
          <Link to="/" className="brand" current={section === '/'}>
            <Mark size={collapsed && !drawer ? 28 : 26} title={collapsed && !drawer ? 'Recourse, home' : undefined} />
            <span className="wordmark">Recourse</span>
          </Link>
          <button type="button" className="icon-btn sb-toggle" aria-label={collapsed ? 'Expand the sidebar' : 'Collapse the sidebar'} aria-expanded={!collapsed} aria-controls="sidebar" title={`${collapsed ? 'Expand' : 'Collapse'} the sidebar (Ctrl+B)`} onClick={toggle}>
            <Icons.panel />
          </button>
          <button type="button" className="icon-btn sb-close" aria-label="Close the menu" onClick={() => setDrawer(false)}>
            <Icons.close />
          </button>
        </div>
        <nav className="sb-nav" aria-label="Screens">
          <p className="sb-group" id="g-walk">Walkthrough</p>
          <ul aria-labelledby="g-walk">{WALKTHROUGH.map((it) => item(it, section === it.key))}</ul>
          <p className="sb-group" id="g-console">Console</p>
          <ul aria-labelledby="g-console">
            {CONSOLE.map((it) =>
              item({ ...it, count: it.page === 'cases' ? caseCount : null }, consolePage === it.page, it.page === 'case' && caseParam ? `${it.to}&case=${caseParam}` : it.to),
            )}
          </ul>
        </nav>
        <div className="sb-bottom">
          <ul>
            {item({ key: '/judges', to: '/judges', label: 'For judges', icon: Icons.judges }, section === '/judges')}
            <li>
              <button type="button" className="sb-item" aria-pressed={clerkOpen} onClick={askClerk}>
                <span className="sb-ico">
                  <Icons.clerk />
                </span>
                <span className="sb-label">{clerkOpen ? 'Hide the Clerk' : 'Ask the Clerk'}</span>
                <span className="sb-tip" aria-hidden="true">{clerkOpen ? 'Hide the Clerk' : 'Ask the Clerk'}</span>
              </button>
            </li>
          </ul>
          <span className="sandbox-pill" title="Every PayPal call goes to the PayPal sandbox. No real money moves.">
            <span className="sb-dot" aria-hidden="true" />
            <span className="sb-label">PayPal sandbox</span>
          </span>
        </div>
      </aside>
      <div className="main">{children}</div>
    </div>
  );
}
