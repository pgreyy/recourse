import { AgGridReact } from 'ag-grid-react';
import type { ColDef } from 'ag-grid-community';
import { useMemo } from 'react';
import { api, ErrorNote, money, navigate, plural, SettlementStatus, useLoad, Verdict, verdictLabel } from '../lib';
import { gridTheme } from './gridTheme';

/** What each case is waiting for, worked out from its state. */
export function nextStep(c: any): string | null {
  if (c.status === 'CLOSED') return null;
  if (c.verdict_state === 'NOT_ASSESSED') return 'Assess';
  if (c.verdict_state === 'ASSESSED') return c.verdict === 'INCONCLUSIVE' ? 'Review evidence' : 'Approve ruling';
  if (c.ruling_status === 'APPEALED') return 'Decide appeal';
  if (c.verdict === 'AGENT_FAULT' && !c.operator_accepted && c.settlement_status !== 'RECOVERED') return 'Operator acceptance';
  if (c.settlement_status && !['RECOVERED', 'COMPLETED', 'NO_ACTION'].includes(c.settlement_status)) return 'Settlement in progress';
  return null;
}

const open = (c: any) => navigate(`/console?page=case&case=${c.id}`);

/** Cases waiting for a person, as an AG Grid in the console theme. A row opens the case. */
export function AttentionList() {
  const r = useLoad((signal) => api<any[]>('/console/cases', { signal }), []);
  const rows = useMemo(() => (r.data ?? []).map((c) => ({ ...c, step: nextStep(c) })).filter((x) => x.step), [r.data]);
  const cols = useMemo<ColDef[]>(
    () => [
      { headerName: 'Case', field: 'case_ref', minWidth: 215, cellClass: 'mono', tooltipValueGetter: () => 'Open the case' },
      { headerName: 'Opened by', valueGetter: (p) => (p.data?.source === 'PAYPAL_DISPUTE' ? 'PayPal dispute' : 'Buyer report'), minWidth: 130 },
      { headerName: 'Agent', valueGetter: (p) => p.data?.agent ?? '—', minWidth: 140 },
      { headerName: 'Amount', type: 'rightAligned', valueGetter: (p) => p.data?.amount, valueFormatter: (p) => money(p.value), minWidth: 110, maxWidth: 130 },
      { headerName: 'Verdict', valueGetter: (p) => verdictLabel(p.data?.verdict), minWidth: 150, cellRenderer: (p: any) => <Verdict v={p.data?.verdict} /> },
      { headerName: 'Settlement', valueGetter: (p) => p.data?.settlement_status, minWidth: 160, cellRenderer: (p: any) => <SettlementStatus s={p.data?.settlement_status} /> },
      { headerName: 'Waiting for', field: 'step', minWidth: 170, cellStyle: { fontWeight: 600 } },
    ],
    [],
  );
  return (
    <section className="card" style={{ height: '100%', display: 'flex', flexDirection: 'column' }} aria-labelledby="att-title">
      <div className="card-head">
        <h2 id="att-title">Needs a decision</h2>
        <span className="small muted">{r.data ? `${rows.length} of ${plural(r.data.length, 'case')}. Select a row to open it.` : ''}</span>
      </div>
      <ErrorNote error={r.error} />
      <div style={{ flex: 1, minHeight: 120 }}>
        <AgGridReact
          theme={gridTheme}
          rowData={rows}
          loading={r.loading && !r.data}
          columnDefs={cols}
          defaultColDef={{ flex: 1, sortable: true, resizable: true, suppressHeaderMenuButton: true }}
          rowHeight={40}
          getRowId={(p) => p.data.id}
          onRowClicked={(e) => e.data && open(e.data)}
          onCellKeyDown={(e: any) => e.event?.key === 'Enter' && e.data && open(e.data)}
          overlayNoRowsTemplate="Nothing is waiting for a decision."
        />
      </div>
    </section>
  );
}
