import { AgGridReact } from 'ag-grid-react';
import type { ColDef } from 'ag-grid-community';
import { useMemo, useState } from 'react';
import { api, ErrorNote, pct, short, Status, useLoad, verdictLabel, when } from '../lib';
import { gridTheme } from './gridTheme';

export function Scorecard() {
  const r = useLoad((signal) => api<{ runs: any[] }>('/scorecard', { signal }), []);
  const [sel, setSel] = useState<string | null>(null);
  const runs = r.data?.runs ?? [];
  const run = runs.find((x) => x.id === sel) ?? runs[0];

  const runCols = useMemo<ColDef[]>(
    () => [
      { headerName: 'Model', valueGetter: (p) => `${p.data.model_provider}/${p.data.model_id}`, minWidth: 160 },
      { headerName: 'Prompt hash', field: 'prompt_version_hash', valueFormatter: (p) => short(p.value, 10), cellClass: 'mono', minWidth: 130 },
      { headerName: 'Cases', field: 'cases_total', type: 'rightAligned', minWidth: 90, maxWidth: 100 },
      { headerName: 'Accuracy', field: 'accuracy', type: 'rightAligned', valueFormatter: (p) => `${pct(p.value)} (${p.data.correct}/${p.data.cases_total})`, minWidth: 140 },
      { headerName: 'False agent fault', field: 'false_agent_fault_rate', type: 'rightAligned', valueFormatter: (p) => pct(p.value), minWidth: 150 },
      { headerName: 'Inconclusive', field: 'inconclusive_rate', type: 'rightAligned', valueFormatter: (p) => pct(p.value), minWidth: 130 },
      { headerName: 'Model calls', field: 'ai_calls', type: 'rightAligned', minWidth: 120, maxWidth: 130 },
      { headerName: 'Fixtures', field: 'fixtures_version', minWidth: 120 },
      { headerName: 'Run', valueGetter: (p) => p.data.finished_at ?? p.data.created_at ?? p.data.started_at, valueFormatter: (p) => when(p.value), sort: 'desc', minWidth: 170 },
    ],
    [],
  );
  const caseCols = useMemo<ColDef[]>(
    () => [
      { headerName: 'Fixture', field: 'id', cellClass: 'mono', minWidth: 95, maxWidth: 105, pinned: 'left' },
      
      { headerName: 'Expected', field: 'expected', valueFormatter: (p) => verdictLabel(p.value), filter: 'agSetColumnFilter', minWidth: 140 },
      { headerName: 'Got', field: 'got', valueFormatter: (p) => verdictLabel(p.value), filter: 'agSetColumnFilter', minWidth: 140 },
      { headerName: 'Result', field: 'correct', valueGetter: (p) => (p.data.correct ? 'Correct' : 'Wrong'), filter: 'agSetColumnFilter', minWidth: 115, cellRenderer: (p: any) => <Status tone={p.data.correct ? 'ok' : 'bad'}>{p.value}</Status> },
      { headerName: 'Model said', field: 'model_verdict', valueFormatter: (p) => (p.value ? verdictLabel(p.value) : 'not asked (code decided)'), minWidth: 150 },
      { headerName: 'Validation problems', valueGetter: (p) => (p.data.validation_problems ?? []).join('; ') || 'none', minWidth: 180, flex: 2, tooltipValueGetter: (p) => (p.data.validation_problems ?? []).join('; ') },
      { headerName: 'Flags', headerTooltip: 'Instruction-like text found in the evidence (code)', field: 'injection_flags', type: 'rightAligned', minWidth: 85, maxWidth: 95 },
      { headerName: 'Human review', valueGetter: (p) => (p.data.requires_human_review ? 'Required' : 'No'), minWidth: 130, maxWidth: 140 },
    ],
    [],
  );

  return (
    <div className="w grid-w" style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div className="w-head">
        <div>
          <h2>Assessment scorecard</h2>
          <p>The assessment pipeline (code checks, then the model, then validation) on fixed test cases with known answers. The number that matters most: how often it blames an agent wrongly.</p>
        </div>
      </div>
      <ErrorNote error={r.error} />
      <div style={{ height: Math.min(56 + runs.length * 42 + 2, 260) }}>
        <AgGridReact
          theme={gridTheme}
          rowData={runs}
          loading={r.loading && !r.data}
          columnDefs={runCols}
          defaultColDef={{ flex: 1, sortable: true, resizable: true }}
          rowHeight={42}
          rowSelection={{ mode: 'singleRow', checkboxes: false, enableClickSelection: true }}
          getRowId={(p) => p.data.id}
          onRowClicked={(e) => setSel(e.data.id)}
          onFirstDataRendered={(e) => e.api.getRowNode(runs[0]?.id)?.setSelected(true)}
        />
      </div>
      {run && (
        <h3>
          Per case: {run.model_provider}/{run.model_id}, {run.correct} of {run.cases_total} correct
        </h3>
      )}
      <div style={{ flex: 1, minHeight: 360 }}>
        <AgGridReact theme={gridTheme} rowData={run?.results ?? []} columnDefs={caseCols} defaultColDef={{ flex: 1, sortable: true, resizable: true, filter: true }} rowHeight={42} />
      </div>
    </div>
  );
}
