import { AgStudio, AgStudioProvider, createWidgets } from 'ag-studio-react';
import { AgStudioAiModule, createAiHarness, studioTheme, type AgAiHarness, type AgDataSourcesDefinition, type AgStudioApiReadyEvent } from 'ag-studio';
import { AllEnterpriseModule, ModuleRegistry } from 'ag-grid-enterprise';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, navigate, useLocation } from '../lib';
import { clerkAgent, CLERK_STARTERS } from './clerk';
import { ClerkPanel } from './ClerkPanel';
import { WIDGETS, PAGES, type PageId } from './widgets';

ModuleRegistry.registerModules([AllEnterpriseModule]);

// One theme for Studio: the app's paper, ink and single teal accent, IBM Plex type.
const theme = studioTheme.withParams({
  accentColor: '#0b4f4a',
  backgroundColor: '#ffffff',
  foregroundColor: '#14201f',
  borderColor: '#e0ddd5',
  borderRadius: 6,
  fontFamily: "'IBM Plex Sans', system-ui, sans-serif",
  fontSize: 14,
  studioCanvasBackgroundColor: '#f5f4f0',
  studioCanvasFontFamily: "'IBM Plex Sans', system-ui, sans-serif",
  studioMinWidth: 0,
  studioMinHeight: 0,
  gridHeaderBackgroundColor: '#faf9f6',
  gridHeaderTextColor: '#44514f',
  gridOddRowBackgroundColor: '#ffffff',
  gridRowHoverColor: '#eef4f3',
} as any);

// View mode with no Studio side panels: the console is read-only; the Clerk has its own panel.
const PANELS = { view: { right: [] as never[], left: [] as never[] } };

const LICENSE = (import.meta.env.VITE_AG_STUDIO_LICENSE_KEY as string | undefined) || undefined;

const RAIL: Array<{ id: PageId; label: string }> = [
  { id: 'overview', label: 'Overview' },
  { id: 'cases', label: 'Cases' },
  { id: 'case', label: 'Case detail' },
  { id: 'agents', label: 'Agents and operators' },
  { id: 'scorecard', label: 'Scorecard' },
];

export function Console() {
  const { query } = useLocation();
  const page = (PAGES.includes(query.get('page') as PageId) ? query.get('page') : 'overview') as PageId;
  const ref = useRef<AgStudio<any>>(null);
  const [ready, setReady] = useState(false);
  const [data, setData] = useState<AgDataSourcesDefinition | undefined>();
  const [caseCount, setCaseCount] = useState<number | null>(null);
  const [harness, setHarness] = useState<AgAiHarness | null>(null);
  const [clerkOpen, setClerkOpen] = useState(query.get('clerk') === '1');

  // The Studio data engine gets the real case rows too, so the Studio data panel and widgets agree.
  const onApiReady = useCallback((e: AgStudioApiReadyEvent) => {
    // The Clerk: a custom agent on Studio's own harness (turn loop, conversation, tool execution).
    setHarness(createAiHarness(e.api as any, () => ({ agents: [clerkAgent(e.api as any)], primary: 'clerk', promptStarters: CLERK_STARTERS })));
    api<any[]>('/console/cases').then((rows) => {
      setCaseCount(rows.length);
      setData({
        sources: [
          {
            id: 'cases',
            data: rows.map((r) => ({
              case_ref: r.case_ref,
              status: r.status,
              source: r.source,
              agent: r.agent ?? 'none',
              operator: r.operator ?? 'none',
              verdict: r.verdict ?? 'NOT_ASSESSED',
              amount: r.amount ? Number(r.amount.value) : 0,
              recovered: r.recovered ? Number(r.recovered.value) : 0,
              settlement_status: r.settlement_status ?? 'NONE',
              created: r.created_at,
            })),
          },
        ],
      });
    });
  }, []);

  useEffect(() => {
    const close = () => setClerkOpen(false);
    window.addEventListener('clerk:close', close);
    return () => window.removeEventListener('clerk:close', close);
  }, []);

  useEffect(() => {
    const a = ref.current?.api;
    if (!ready || !a) return;
    const s = a.getState();
    if (s.selectedPageId !== page) a.setState({ ...s, selectedPageId: page });
  }, [page, ready]);

  const initialState = useMemo(
    () => ({
      pages: [
        {
          id: 'overview',
          widgets: { kpis: { type: 'rc-kpis' }, byAgent: { type: 'rc-recovered-by-agent' }, exposure: { type: 'rc-exposure' }, attention: { type: 'rc-attention' } },
          widgetLayout: {
            kpis: { xTrack: 0, yTrack: 0, xSpan: 24, ySpan: 16 },
            attention: { xTrack: 0, yTrack: 16, xSpan: 24, ySpan: 18 },
            byAgent: { xTrack: 0, yTrack: 34, xSpan: 12, ySpan: 15 },
            exposure: { xTrack: 12, yTrack: 34, xSpan: 12, ySpan: 15 },
          },
        },
        { id: 'cases', layout: { type: 'standalone' }, widgets: { grid: { type: 'rc-cases' } } },
        { id: 'case', layout: { type: 'standalone' }, widgets: { detail: { type: 'rc-case' } } },
        { id: 'agents', layout: { type: 'standalone' }, widgets: { rep: { type: 'rc-reputation' } } },
        { id: 'scorecard', layout: { type: 'standalone' }, widgets: { sc: { type: 'rc-scorecard' } } },
      ],
      selectedPageId: page,
      panels: { filters: { collapsed: true } },
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const widgets = useMemo(() => createWidgets<any>({ additionalTypes: WIDGETS as any, menu: [{ label: 'Recourse', widgetIds: WIDGETS.map((w) => w.id) }] }), []);


  const layout = useMemo(() => ({ widgetBorderEnabled: false, widgetPadding: 0, pagePadding: 16, widgetBackgroundColor: 'transparent', backgroundColor: '#f5f4f0' }), []);

  return (
    <div className={`console${clerkOpen ? ' with-clerk' : ''}`}>
      <nav className="rail" aria-label="Console sections">
        <h3>Console</h3>
        {RAIL.map((r) => (
          <button key={r.id} aria-current={page === r.id ? 'page' : undefined} onClick={() => navigate(`/console?page=${r.id}${r.id === 'case' && query.get('case') ? `&case=${query.get('case')}` : ''}`)}>
            <span>{r.label}</span>
            {r.id === 'cases' && caseCount !== null && <span className="count">{caseCount}</span>}
          </button>
        ))}
        <div className="clerk-hint">
          <button className="btn secondary" style={{ width: '100%' }} onClick={() => setClerkOpen((o) => !o)} aria-expanded={clerkOpen}>
            {clerkOpen ? 'Hide the Clerk' : 'Ask the Clerk'}
          </button>
          <p style={{ marginTop: 8 }}>A read-only assistant for cases, rulings and settlements. It can propose an action; only the buttons on a case carry it out.</p>
        </div>
      </nav>
      <div className="studio-host">
        <AgStudioProvider modules={[AgStudioAiModule]} licenseKey={LICENSE}>
          <AgStudio<any>
            ref={ref}
            style={{ height: '100%', width: '100%' }}
            theme={theme}
            data={data}
            mode="view"
            panels={PANELS}
            initialState={initialState as any}
            widgets={widgets}
            layout={layout as any}
            onApiReady={onApiReady}
            onStudioReady={() => setReady(true)}
          />
        </AgStudioProvider>
      </div>
      {clerkOpen && <ClerkPanel harness={harness} onClose={() => setClerkOpen(false)} />}
    </div>
  );
}
