import { AgGridReact } from 'ag-grid-react';
import type { ColDef, GridApi, RowClickedEvent } from 'ag-grid-community';
import { useMemo, useRef, useState } from 'react';
import { api, ErrorNote, Id, money, navigate, plural, SettlementStatus, shortWhen, Status, useLoad, Verdict, verdictLabel } from '../lib';
import { gridTheme } from './gridTheme';
import { nextStep } from './Overview';

const EVIDENCE_TONE = (label: string) => (label === 'Intact, anchored' ? 'ok' : label.startsWith('Intact') ? 'neutral' : 'bad');
const two0 = (a: React.ReactNode, b?: string | null) => (
  <span style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 2, justifyContent: 'center', height: '100%', lineHeight: 1.3 }}>
    {a}
    {b && <span className="small muted">{b}</span>}
  </span>
);
const settlementLabel = (s?: string | null) =>
  ({ OPEN: 'Open', BUYER_REFUNDED: 'Buyer refunded', AWAITING_CONFIRMATION: 'Pending confirmation', INVOICED: 'Invoiced', AWAITING_PAYPAL: 'Awaiting PayPal', RECOVERED: 'Recovered', COMPLETED: 'Completed', FAILED: 'Failed', NO_ACTION: 'No charge' } as Record<string, string>)[s ?? ''] ?? 'No settlement';

type GroupBy = 'none' | 'verdict' | 'agent';

export function CasesGrid() {
  const r = useLoad((signal) => api<any[]>('/console/cases', { signal }), []);
  const [group, setGroup] = useState<GroupBy>('none');
  const [open, setOpen] = useState<any | null>(null);
  const gridApi = useRef<GridApi | null>(null);

  const two = (a: string, b?: string | null, mono = false) => (
    <span style={{ display: 'flex', flexDirection: 'column', lineHeight: 1.3, justifyContent: 'center', height: '100%' }}>
      <span className={mono ? 'mono' : ''}>{a}</span>
      {b && <span className={`small muted${mono ? ' mono' : ''}`}>{b}</span>}
    </span>
  );
  const cols = useMemo<ColDef[]>(
    () => [
      { colId: 'case', headerName: 'Case', headerTooltip: 'Case reference, then the order', valueGetter: (p) => p.data?.case_ref, minWidth: 190, pinned: 'left', cellRenderer: (p: any) => (p.data ? two(p.data.case_ref, p.data.order_ref, true) : null) },
      { colId: 'order', headerName: 'Order', field: 'order_ref', hide: true },
      { colId: 'agent', headerName: 'Agent', headerTooltip: 'Agent version, then its operator', valueGetter: (p) => (p.data ? p.data.agent ?? 'No agent' : undefined), rowGroup: group === 'agent', hide: group === 'agent', filter: 'agSetColumnFilter', minWidth: 150, cellRenderer: (p: any) => (p.data ? two(p.value, p.data.operator) : p.value ?? null) },
      { colId: 'operator', headerName: 'Operator', valueGetter: (p) => p.data?.operator ?? '—', filter: 'agSetColumnFilter', hide: true },
      { colId: 'amount', headerName: 'Amount', type: 'rightAligned', headerTooltip: 'Group rows show the sum', valueGetter: (p) => (p.data?.amount ? Number(p.data.amount.value) : null), valueFormatter: (p) => (p.data?.amount ? money(p.data.amount) : p.value != null ? p.value.toFixed(2) : ''), aggFunc: 'sum', filter: 'agNumberColumnFilter', minWidth: 104, maxWidth: 120 },
      {
        colId: 'verdict',
        headerName: 'Verdict',
        valueGetter: (p) => (p.data ? verdictLabel(p.data.verdict) : undefined),
        rowGroup: group === 'verdict',
        hide: group === 'verdict',
        filter: 'agSetColumnFilter',
        minWidth: 140,
        cellRenderer: (p: any) => (p.data ? two0(<Verdict v={p.data.verdict} />, p.data.verdict_state === 'ASSESSED' ? 'proposed, not ruled' : p.data.verdict_state === 'RULED' ? 'ruling approved' : null) : p.value ?? null),
      },
      { colId: 'evidence', headerName: 'Evidence', valueGetter: (p) => (p.data ? p.data.evidence?.label : undefined), filter: 'agSetColumnFilter', minWidth: 140, cellRenderer: (p: any) => (p.data ? <Status tone={EVIDENCE_TONE(p.value)}>{p.value}</Status> : null) },
      { colId: 'settlement', headerName: 'Settlement', valueGetter: (p) => (p.data ? settlementLabel(p.data.settlement_status) : undefined), filter: 'agSetColumnFilter', minWidth: 150, cellRenderer: (p: any) => (p.data ? <SettlementStatus s={p.data.settlement_status} /> : null) },
      { colId: 'recovered', headerName: 'Recovered', type: 'rightAligned', valueGetter: (p) => (p.data?.recovered ? Number(p.data.recovered.value) : p.data ? 0 : null), valueFormatter: (p) => (p.data ? (p.data.recovered ? money(p.data.recovered) : '—') : p.value != null ? p.value.toFixed(2) : ''), aggFunc: 'sum', minWidth: 104, maxWidth: 120 },
      { colId: 'created', headerName: 'Opened', headerTooltip: 'When the case was opened (UTC)', valueGetter: (p) => p.data?.created_at, valueFormatter: (p) => shortWhen(p.value), filter: 'agDateColumnFilter', floatingFilter: false, sort: 'desc', minWidth: 120, maxWidth: 130 },
    ],
    [group],
  );

  return (
    <div className="w grid-w" style={{ position: 'relative', display: 'flex', flexDirection: 'column' }}>
      <div className="w-head">
        <div>
          <h2>Cases</h2>
          <p>Every case opened by a buyer report or a PayPal dispute. Select a row for a summary.</p>
        </div>
        <div className="row" role="group" aria-label="Group rows by">
          <span className="small muted">Group by</span>
          {(['none', 'verdict', 'agent'] as GroupBy[]).map((g) => (
            <button key={g} className={`btn small ${group === g ? '' : 'secondary'}`} aria-pressed={group === g} onClick={() => setGroup(g)}>
              {g === 'none' ? 'None' : g === 'verdict' ? 'Verdict' : 'Agent'}
            </button>
          ))}
        </div>
      </div>
      <ErrorNote error={r.error} />
      <div style={{ flex: 1, minHeight: 320 }}>
        <AgGridReact
          theme={gridTheme}
          rowData={r.data ?? []}
          loading={r.loading && !r.data}
          columnDefs={cols}
          defaultColDef={{ flex: 1, filter: true, floatingFilter: true, sortable: true, resizable: true, wrapHeaderText: true, autoHeaderHeight: true, suppressHeaderMenuButton: true }}
          autoGroupColumnDef={{ headerName: group === 'agent' ? 'Agent' : 'Verdict', minWidth: 170, pinned: 'left' }}
          groupDefaultExpanded={1}
          groupDisplayType="singleColumn"
          suppressAggFuncInHeader
          rowHeight={54}
          rowSelection={{ mode: 'singleRow', checkboxes: false, enableClickSelection: true }}
          getRowId={(p) => p.data.id}
          onGridReady={(e) => (gridApi.current = e.api)}
          onRowClicked={(e: RowClickedEvent) => e.data && setOpen(e.data)}
          onCellKeyDown={(e: any) => e.event?.key === 'Enter' && e.data && setOpen(e.data)}
          overlayNoRowsTemplate="No cases yet."
        />
      </div>
      {open && <Drawer c={open} onClose={() => setOpen(null)} />}
    </div>
  );
}

function Drawer({ c, onClose }: { c: any; onClose: () => void }) {
  const step = nextStep(c);
  return (
    <aside className="drawer stack" aria-label={`Case ${c.case_ref}`} onKeyDown={(e) => e.key === 'Escape' && onClose()}>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <h2 className="mono" style={{ fontSize: 15 }}>
          {c.case_ref}
        </h2>
        <button className="btn small secondary" onClick={onClose} autoFocus>
          Close
        </button>
      </div>
      <div className="row">
        <Verdict v={c.verdict} />
        <SettlementStatus s={c.settlement_status} />
      </div>
      <dl className="kv">
        <dt>Opened by</dt>
        <dd>{c.source === 'PAYPAL_DISPUTE' ? `PayPal dispute ${c.dispute_id}` : 'Buyer report on the receipt'}</dd>
        <dt>Case status</dt>
        <dd>{c.status.replace(/_/g, ' ').toLowerCase()}</dd>
        <dt>Agent</dt>
        <dd>{c.agent ?? '—'}</dd>
        <dt>Operator</dt>
        <dd>{c.operator ?? '—'}</dd>
        <dt>Amount</dt>
        <dd>{money(c.amount)}</dd>
        <dt>Recovered</dt>
        <dd>{c.recovered ? money(c.recovered) : 'Nothing confirmed'}</dd>
        <dt>PayPal order</dt>
        <dd>
          <Id>{c.paypal_order_id ?? '—'}</Id>
        </dd>
        <dt>PayPal capture</dt>
        <dd>
          <Id>{c.paypal_capture_id ?? '—'}</Id>
        </dd>
        <dt>Evidence</dt>
        <dd>
          {c.evidence.label}, {plural(c.evidence.entries, 'recorder entry', 'recorder entries')}
        </dd>
        <dt>Waiting for</dt>
        <dd>{step ?? 'Nothing, closed'}</dd>
      </dl>
      <div>
        <button className="btn" onClick={() => navigate(`/console?page=case&case=${c.id}`)}>
          Open case
        </button>
      </div>
    </aside>
  );
}
