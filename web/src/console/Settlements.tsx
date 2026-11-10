import { AgGridReact } from 'ag-grid-react';
import type { ColDef } from 'ag-grid-community';
import { useMemo } from 'react';
import { api, ErrorNote, money, navigate, plural, SettlementStatus, shortWhen, useLoad, verdictLabel } from '../lib';
import { gridTheme } from './gridTheme';
import { WhoPaid } from './WhoPaid';

const KIND: Record<string, string> = { RECOVERY: 'Recovery', DISPUTE_RESPONSE: 'Dispute response', NO_CHARGE: 'No charge', REVERSAL: 'Reversal' };
const ACTION: Record<string, string> = {
  REFUND_BUYER: 'Refund the buyer',
  CHARGE_OPERATOR: 'Charge the operator',
  INVOICE_OPERATOR: 'Invoice the operator',
  REFUND_OPERATOR: 'Refund the operator',
  DISPUTE_ESCALATE: 'Escalate the dispute',
  DISPUTE_PROVIDE_EVIDENCE: 'File evidence with PayPal',
  DISPUTE_ACCEPT_CLAIM: 'Accept the claim',
  DISPUTE_MAKE_OFFER: 'Make an offer',
};
const ids = (x: Record<string, string> | null | undefined) =>
  Object.entries(x ?? {})
    .map(([k, v]) => `${k.replace(/_id$/, '')} ${v}`)
    .join(', ');

/** Every settlement obligation with its PayPal actions. A row opens its case. */
export function Settlements() {
  const r = useLoad((signal) => api<any[]>('/settlements', { signal }), []);
  const two = (a: string, b?: string | null, mono = false) => (
    <span style={{ display: 'flex', flexDirection: 'column', lineHeight: 1.3, justifyContent: 'center', height: '100%', minWidth: 0 }}>
      <span className={mono ? 'mono' : ''}>{a}</span>
      {b && <span className="small muted" style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{b}</span>}
    </span>
  );
  const cols = useMemo<ColDef[]>(
    () => [
      { headerName: 'Case', field: 'case_ref', minWidth: 190, cellRenderer: (p: any) => (p.data ? two(p.data.case_ref, verdictLabel(p.data.verdict), true) : null) },
      { headerName: 'Kind', valueGetter: (p) => KIND[p.data?.kind] ?? p.data?.kind, minWidth: 150, cellRenderer: (p: any) => (p.data ? two(p.value, p.data.operator ?? 'No operator') : null) },
      { headerName: 'Status', valueGetter: (p) => p.data?.status, minWidth: 150, cellRenderer: (p: any) => <SettlementStatus s={p.data?.status} /> },
      { headerName: 'Amount', type: 'rightAligned', valueGetter: (p) => (p.data ? Number(p.data.amount.value) : null), valueFormatter: (p) => (p.data ? money(p.data.amount) : ''), cellClass: 'mono', minWidth: 104, maxWidth: 124 },
      { headerName: 'Recovered', type: 'rightAligned', valueGetter: (p) => (p.data?.status === 'RECOVERED' ? Number(p.data.recovered.value) : 0), valueFormatter: (p) => (p.data?.status === 'RECOVERED' ? money(p.data.recovered) : '—'), cellClass: 'mono', minWidth: 104, maxWidth: 124 },
      {
        headerName: 'PayPal actions',
        flex: 2,
        minWidth: 230,
        autoHeight: true,
        valueGetter: (p) => (p.data?.actions ?? []).length,
        cellRenderer: (p: any) => (
          <ul className="acts">
            {(p.data?.actions ?? []).map((a: any, i: number) => (
              <li key={i}>
                <span>{ACTION[a.action] ?? a.action}</span> <span className="mono small muted">{ids(a.paypal_ids)}</span>{' '}
                <span className={`small ${a.confirmation === 'confirmed' ? 'ok-text' : 'muted'}`}>{a.confirmation === 'confirmed' ? 'confirmed' : 'pending'}</span>
              </li>
            ))}
          </ul>
        ),
      },
      {
        headerName: 'Who paid what',
        minWidth: 220,
        autoHeight: true,
        valueGetter: (p) => (p.data?.who_paid ? 1 : 0),
        cellRenderer: (p: any) => (p.data?.who_paid ? <WhoPaid w={p.data.who_paid} compact /> : <span className="small muted">{p.data?.status === 'RECOVERED' ? '' : 'once PayPal confirms'}</span>),
      },
      { headerName: 'Updated', valueGetter: (p) => p.data?.updated_at, valueFormatter: (p) => shortWhen(p.value), sort: 'desc', minWidth: 112, maxWidth: 124 },
    ],
    [],
  );
  const rows = r.data ?? [];
  return (
    <div className="w grid-w" style={{ display: 'flex', flexDirection: 'column' }}>
      <div className="w-toolbar">
        <span className="small muted">{r.data ? plural(rows.length, 'settlement') : ''}</span>
      </div>
      <ErrorNote error={r.error} />
      <div style={{ flex: 1, minHeight: 280 }}>
        <AgGridReact
          theme={gridTheme}
          rowData={rows}
          loading={r.loading && !r.data}
          columnDefs={cols}
          defaultColDef={{ flex: 1, sortable: true, resizable: true, suppressHeaderMenuButton: true, wrapHeaderText: true, autoHeaderHeight: true }}
          getRowId={(p) => p.data.id}
          onRowClicked={(e) => e.data && navigate(`/console?page=case&case=${e.data.case_id}`)}
          onCellKeyDown={(e: any) => e.event?.key === 'Enter' && e.data && navigate(`/console?page=case&case=${e.data.case_id}`)}
          overlayNoRowsTemplate="No settlements yet. A settlement starts when a decision is approved."
        />
      </div>
    </div>
  );
}
