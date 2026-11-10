import { AgStudio, AgStudioProvider, createWidgets } from 'ag-studio-react';
import { AgStudioAiModule, createAiHarness, studioTheme, type AgAiHarness, type AgDataSourcesDefinition, type AgStudioApiReadyEvent } from 'ag-studio';
import { AllEnterpriseModule, ModuleRegistry } from 'ag-grid-enterprise';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, ErrorNote, navigate, useLocation, verdictLabel } from '../lib';
import { nextStep } from './Overview';
import { clerkAgent, CLERK_STARTERS } from './clerk';
import { ClerkPanel } from './ClerkPanel';
import { WIDGETS, PAGES, type PageId } from './widgets';

ModuleRegistry.registerModules([AllEnterpriseModule]);

// One theme for Studio: the app's paper, ink and single teal accent, IBM Plex type.
const theme = studioTheme.withParams({
  accentColor: '#0b4f4a',
  backgroundColor: '#fffdf8',
  foregroundColor: '#161a19',
  borderColor: '#e2dccf',
  borderRadius: 4,
  fontFamily: "'IBM Plex Sans', system-ui, sans-serif",
  fontSize: 14,
  studioCanvasBackgroundColor: '#f6f3ec',
  studioCanvasFontFamily: "'IBM Plex Sans', system-ui, sans-serif",
  studioMinWidth: 0,
  studioCanvasMinWidth: 0,
  studioCanvasStandaloneMinWidth: 0,
  studioMinHeight: 0,
  gridHeaderBackgroundColor: '#f9f6ef',
  gridHeaderTextColor: '#3d4542',
  gridOddRowBackgroundColor: '#fffdf8',
  gridRowHoverColor: '#eef4f3',
  // Charts: IBM Plex, ink text, teal for money recovered, amber for money still pending.
  chartFontFamily: "'IBM Plex Sans', system-ui, sans-serif",
  chartFontSize: 12,
  chartTextColor: '#161a19',
  chartSubtleTextColor: '#59615e',
  chartGridLineColor: '#ebe5d9',
  chartAxisLineColor: '#c4bba8',
  chartPaletteFills1Color: '#0b4f4a',
  chartPaletteStrokes1Color: '#0b4f4a',
  chartPaletteFills2Color: '#857a62',
  chartPaletteStrokes2Color: '#857a62',
} as any);

// Built-in AG Studio widgets on the overview share one card look.
const CARD = { backgroundColor: '#fffdf8', borderEnabled: true, borderWidth: 1, borderColor: '#e2dccf', borderRadius: 4 };
// Titles like the console's card headings; tile labels small and quiet, values large.
const HEADING = { typography: { fontFamily: "'Fraunces', Georgia, serif", fontSize: 17, fontWeight: 'bold' }, color: '#161a19' };
const SUBHEAD = { typography: { fontFamily: "'IBM Plex Sans', system-ui, sans-serif", fontSize: 12.5 }, color: '#59615e', wrapping: true };
const money2 = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const MONEY = { format: 'currencyFormat', formatOptions: { format: money2 } } as const;
const COUNT = { format: 'integerFormat' } as const;
const TEXT = { format: 'textFormat' } as const;
const sum = (list: Array<{ value: string }> = []) => list.reduce((t, m) => t + Number(m.value), 0);
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

type Loaded = { cases: any[]; overview: any };

/** The Studio data engine's tables: cases, the headline numbers and operator exposure, all from the Recourse API. */
function dataSources(l: Loaded): AgDataSourcesDefinition {
  const o = l.overview;
  return {
    sources: [
      {
        id: 'cases',
        name: 'Cases',
        data: l.cases.map((r) => ({
          case_ref: r.case_ref,
          agent: r.agent ?? 'No agent',
          operator: r.operator ?? 'No operator',
          verdict: verdictLabel(r.verdict),
          waiting: nextStep(r) ?? 'Nothing',
          amount: r.amount ? Number(r.amount.value) : 0,
          recovered: r.recovered ? Number(r.recovered.value) : 0,
          pending: r.pending ? Number(r.pending.value) : 0,
        })),
        fields: [
          { id: 'case_ref', name: 'Case', ...TEXT },
          { id: 'agent', name: 'Agent version', ...TEXT },
          { id: 'operator', name: 'Operator', ...TEXT },
          { id: 'verdict', name: 'Verdict', ...TEXT },
          { id: 'waiting', name: 'Waiting for', ...TEXT },
          { id: 'amount', name: 'Amount (USD)', ...MONEY },
          { id: 'recovered', name: 'Recovered (USD)', ...MONEY },
          { id: 'pending', name: 'Pending (USD)', ...MONEY },
        ],
      },
      {
        id: 'headline',
        name: 'Headline numbers',
        data: [
          {
            k_purchases: sum(o.agent_purchases.amount),
            k_open: o.cases_open,
            k_recovered: sum(o.recovered_confirmed.amount),
            k_pending: sum(o.pending_settlement.amount),
            k_exposure: o.exposure.reduce((t: number, e: any) => t + Number(e.used.value), 0),
            k_avoided: Number(o.dispute_costs_avoided_estimate.amount.value),
          },
        ],
        fields: [
          { id: 'k_purchases', name: 'Agent purchases (USD)', ...MONEY },
          { id: 'k_open', name: 'Cases open', ...COUNT },
          { id: 'k_recovered', name: 'Recovered (USD)', ...MONEY },
          { id: 'k_pending', name: 'Pending (USD)', ...MONEY },
          { id: 'k_exposure', name: 'Exposure used (USD)', ...MONEY },
          { id: 'k_avoided', name: 'Dispute costs avoided (USD, estimate)', ...MONEY },
        ],
      },
      {
        id: 'exposure',
        name: 'Operator exposure',
        data: o.exposure.map((e: any) => ({
          x_operator: `${e.operator} (v${e.agreement_version})`,
          x_used: Number(e.used.value),
          x_remaining: Number(e.remaining.value),
          x_cap: Number(e.cap.value),
        })),
        fields: [
          { id: 'x_operator', name: 'Operator', ...TEXT },
          { id: 'x_used', name: 'Used', ...MONEY },
          { id: 'x_remaining', name: 'Left', ...MONEY },
          { id: 'x_cap', name: 'Cap', ...MONEY },
        ],
      },
    ],
    // Named measures, so the chart legend reads "Recovered" and "Pending" (not "Recovered (USD) (sum)").
    expressions: [
      { id: 'recovered_total', name: 'Recovered', isMeasure: true, expression: { id: 'cases.recovered', aggregation: 'sum' }, ...MONEY },
      { id: 'pending_total', name: 'Pending', isMeasure: true, expression: { id: 'cases.pending', aggregation: 'sum' }, ...MONEY },
    ],
  } as any;
}

/** The overview page: six value tiles, the cases needing a decision, one chart and the exposure grid. */
function overviewPage(l: Loaded, narrow = false) {
  const o = l.overview;
  const cap = o.exposure.reduce((t: number, e: any) => t + Number(e.cap.value), 0);
  const tile = (field: string, title: string, caption: string) => ({
    type: 'value',
    dataMapping: { value: [{ id: `headline.${field}`, aggregation: 'sum' }] },
    format: {
      title: { enabled: true, text: title, wrapping: true, typography: { fontFamily: "'IBM Plex Sans', system-ui, sans-serif", fontSize: 12.5, fontWeight: 'bold' }, color: '#3d4542' },
      caption: { enabled: true, text: caption, ...SUBHEAD },
      style: { textAlign: 'left', verticalAlign: 'center', color: '#161a19', typography: { fontFamily: "'IBM Plex Mono', ui-monospace, monospace", fontWeight: 'normal' }, label: { enabled: false } },
      widget: CARD,
    },
  });
  return {
    id: 'overview',
    widgets: {
      purchases: tile('k_purchases', 'Agent purchases', `${plural(o.agent_purchases.count, 'purchase')}, USD`),
      open: tile('k_open', 'Cases open', 'not yet closed'),
      recovered: tile('k_recovered', 'Recovered', `confirmed by PayPal, ${plural(o.recovered_confirmed.count, 'case')}`),
      pending: tile('k_pending', 'Pending', `${plural(o.pending_settlement.count, 'settlement')} not confirmed`),
      exposure: tile('k_exposure', 'Exposure used', `of ${money2.format(cap)} USD in caps`),
      avoided: tile('k_avoided', 'Disputes avoided (estimate)', `${plural(o.dispute_costs_avoided_estimate.cases_resolved_without_dispute, 'case')} × ${o.dispute_costs_avoided_estimate.assumed_fee_per_dispute.value} USD assumed fee`),
      attention: { type: 'rc-attention' },
      chart: {
        type: 'column-chart-stacked',
        dataMapping: { categoryKey: [{ id: 'cases.agent' }], valueKey: [{ id: 'recovered_total' }, { id: 'pending_total' }] },
        format: {
          title: { enabled: true, text: 'Recovered vs pending by agent version', ...HEADING },
          subtitle: { enabled: true, text: 'USD. Recovered counts only what PayPal confirmed; pending is owed or disputed and not yet settled.', ...SUBHEAD },
          style: { theme: { common: { legend: { enabled: true, position: 'bottom' } } } },
          widget: CARD,
        },
      },
      exposureGrid: {
        type: 'grid',
        dataMapping: { cols: [{ id: 'exposure.x_operator' }, { id: 'exposure.x_used' }, { id: 'exposure.x_remaining' }, { id: 'exposure.x_cap' }] },
        format: { title: { enabled: true, text: 'Operator exposure', ...HEADING }, subtitle: { enabled: true, text: 'USD. Accepted liability agreements: what each operator has paid against its total cap.', ...SUBHEAD }, widget: CARD },
      },
    },
    // On a phone the same widgets stack: two tiles per row, then each panel at full width.
    widgetLayout: narrow
      ? {
          purchases: { xTrack: 0, yTrack: 0, xSpan: 12, ySpan: 9 },
          open: { xTrack: 12, yTrack: 0, xSpan: 12, ySpan: 9 },
          recovered: { xTrack: 0, yTrack: 9, xSpan: 12, ySpan: 9 },
          pending: { xTrack: 12, yTrack: 9, xSpan: 12, ySpan: 9 },
          exposure: { xTrack: 0, yTrack: 18, xSpan: 12, ySpan: 9 },
          avoided: { xTrack: 12, yTrack: 18, xSpan: 12, ySpan: 9 },
          attention: { xTrack: 0, yTrack: 27, xSpan: 24, ySpan: 14 },
          chart: { xTrack: 0, yTrack: 41, xSpan: 24, ySpan: 20 },
          exposureGrid: { xTrack: 0, yTrack: 61, xSpan: 24, ySpan: 14 },
        }
      : {
      purchases: { xTrack: 0, yTrack: 0, xSpan: 4, ySpan: 9 },
      open: { xTrack: 4, yTrack: 0, xSpan: 4, ySpan: 9 },
      recovered: { xTrack: 8, yTrack: 0, xSpan: 4, ySpan: 9 },
      pending: { xTrack: 12, yTrack: 0, xSpan: 4, ySpan: 9 },
      exposure: { xTrack: 16, yTrack: 0, xSpan: 4, ySpan: 9 },
      avoided: { xTrack: 20, yTrack: 0, xSpan: 4, ySpan: 9 },
      attention: { xTrack: 0, yTrack: 9, xSpan: 24, ySpan: 12 },
      chart: { xTrack: 0, yTrack: 21, xSpan: 14, ySpan: 19 },
      exposureGrid: { xTrack: 14, yTrack: 21, xSpan: 10, ySpan: 19 },
        },
  };
}

// View mode with no Studio side panels: the console is read-only; the Clerk has its own panel.
const PANELS = { view: { right: [] as never[], left: [] as never[] } };

const LICENSE = (import.meta.env.VITE_AG_STUDIO_LICENSE_KEY as string | undefined) || undefined;

/** Each console screen's header: a title and its purpose in one line. */
const HEAD: Record<PageId, { title: string; purpose: string }> = {
  overview: { title: 'Overview', purpose: 'What agents bought, what is waiting for a decision, and what PayPal has confirmed as recovered.' },
  cases: { title: 'Cases', purpose: 'Every case opened by a buyer report or a PayPal dispute. Select a row for a summary.' },
  case: { title: 'Case detail', purpose: 'One case: what the buyer authorised, what the agent did, and who is responsible.' },
  agents: { title: 'Agents and operators', purpose: "Reputation counts only finalized decisions; the merchant's checkout policy follows from it." },
  settlements: { title: 'Settlements', purpose: 'Every settlement and each PayPal action with its id. Money counts as recovered only once PayPal confirms.' },
  scorecard: { title: 'Assessment scorecard', purpose: 'The assessment pipeline on fixed cases with known answers. The number that matters most: how often it blames an agent wrongly.' },
};

export function Console() {
  const { query } = useLocation();
  const page = (PAGES.includes(query.get('page') as PageId) ? query.get('page') : 'overview') as PageId;
  const ref = useRef<AgStudio<any>>(null);
  const [ready, setReady] = useState(false);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [loadError, setLoadError] = useState<Error | null>(null);
  const [harness, setHarness] = useState<AgAiHarness | null>(null);
  const [clerkOpen, setClerkOpen] = useState(query.get('clerk') === '1');

  // The data is fetched first, then Studio starts with it: tiles, chart and grids are built-in widgets on these tables.
  useEffect(() => {
    Promise.all([api<any[]>('/console/cases'), api<any>('/console/overview')])
      .then(([cases, overview]) => {
        setLoaded({ cases, overview });
        window.dispatchEvent(new CustomEvent('console:cases', { detail: cases.length }));
      })
      .catch(setLoadError);
  }, []);
  const data = useMemo(() => (loaded ? dataSources(loaded) : undefined), [loaded]);

  const onApiReady = useCallback((e: AgStudioApiReadyEvent) => {
    // The Clerk: a custom agent on Studio's own harness (turn loop, conversation, tool execution).
    setHarness(createAiHarness(e.api as any, () => ({ agents: [clerkAgent(e.api as any)], primary: 'clerk', promptStarters: CLERK_STARTERS })));
  }, []);

  // The sidebar's "Ask the Clerk" toggles the panel; the sidebar is told whether it is open.
  useEffect(() => {
    const close = () => setClerkOpen(false);
    const toggle = () => setClerkOpen((o) => !o);
    window.addEventListener('clerk:close', close);
    window.addEventListener('clerk:toggle', toggle);
    return () => {
      window.removeEventListener('clerk:close', close);
      window.removeEventListener('clerk:toggle', toggle);
    };
  }, []);
  useEffect(() => {
    window.dispatchEvent(new CustomEvent('clerk:state', { detail: clerkOpen }));
  }, [clerkOpen]);
  useEffect(() => () => void window.dispatchEvent(new CustomEvent('clerk:state', { detail: false })), []);

  useEffect(() => {
    const a = ref.current?.api;
    if (!ready || !a) return;
    const s = a.getState();
    if (s.selectedPageId !== page) a.setState({ ...s, selectedPageId: page });
  }, [page, ready]);

  const initialState = useMemo(
    () => ({
      pages: [
        loaded ? overviewPage(loaded, window.matchMedia('(max-width: 767px)').matches) : { id: 'overview', widgets: {} },
        { id: 'cases', layout: { type: 'standalone' }, widgets: { grid: { type: 'rc-cases' } } },
        { id: 'case', layout: { type: 'standalone' }, widgets: { detail: { type: 'rc-case' } } },
        { id: 'agents', layout: { type: 'standalone' }, widgets: { rep: { type: 'rc-reputation' } } },
        { id: 'settlements', layout: { type: 'standalone' }, widgets: { st: { type: 'rc-settlements' } } },
        { id: 'scorecard', layout: { type: 'standalone' }, widgets: { sc: { type: 'rc-scorecard' } } },
      ],
      selectedPageId: page,
      panels: { filters: { collapsed: true } },
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [loaded],
  );

  const widgets = useMemo(() => createWidgets<any>({ additionalTypes: WIDGETS as any, menu: [{ label: 'Recourse', widgetIds: WIDGETS.map((w) => w.id) }] }), []);


  const layout = useMemo(() => ({ widgetBorderEnabled: false, widgetPadding: 0, pagePadding: 16, widgetBackgroundColor: 'transparent', backgroundColor: '#f6f3ec' }), []);

  return (
    <div className={`console${clerkOpen ? ' with-clerk' : ''}`}>
      <div className="console-main">
        <header className="page-head console-head">
          <div>
            <h1>{HEAD[page].title}</h1>
            <p>{HEAD[page].purpose}</p>
          </div>
        </header>
      <div className="studio-host">
        {loadError && <ErrorNote error={loadError} />}
        {!loaded && !loadError && <p className="muted" style={{ padding: 16 }}>Loading the console…</p>}
        {loaded && (
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
        )}
      </div>
      </div>
      {clerkOpen && <ClerkPanel harness={harness} onClose={() => setClerkOpen(false)} />}
    </div>
  );
}
