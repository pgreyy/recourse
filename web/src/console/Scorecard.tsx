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
      { headerName: 'Domain', valueGetter: (p) => (p.data.domain === 'travel' ? 'Travel' : 'Retail'), filter: 'agSetColumnFilter', minWidth: 100, maxWidth: 115 },
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
        <>
          <h3>
            Per case: {run.model_provider}/{run.model_id}, {run.correct} of {run.cases_total} correct
          </h3>
          <ByDomain results={run.results ?? []} />
        </>
      )}
      <div style={{ flex: 1, minHeight: 360 }}>
        <AgGridReact theme={gridTheme} rowData={run?.results ?? []} columnDefs={caseCols} defaultColDef={{ flex: 1, sortable: true, resizable: true, filter: true }} rowHeight={42} />
      </div>
    </div>
  );
}

/** The selected run, split by domain: correct, wrongly blamed an agent, and inconclusive. Earlier runs had retail only. */
function ByDomain({ results }: { results: any[] }) {
  const domains = ['retail', 'travel'].map((d) => {
    const rows = results.filter((r) => (r.domain ?? 'retail') === d);
    const notAgent = rows.filter((r) => r.expected !== 'AGENT_FAULT');
    return {
      d,
      n: rows.length,
      correct: rows.filter((r) => r.correct).length,
      falseAgent: notAgent.length ? notAgent.filter((r) => r.got === 'AGENT_FAULT').length / notAgent.length : 0,
      inconclusive: rows.length ? rows.filter((r) => r.got === 'INCONCLUSIVE').length / rows.length : 0,
    };
  });
  return (
    <table className="plain" style={{ maxWidth: 620 }} aria-label="Results by domain">
      <thead>
        <tr>
          <th>Domain</th>
          <th className="num">Correct</th>
          <th className="num">Wrongly blamed an agent</th>
          <th className="num">Inconclusive</th>
        </tr>
      </thead>
      <tbody>
        {domains.map((x) => (
          <tr key={x.d}>
            <td>{x.d === 'travel' ? 'Travel' : 'Retail'}</td>
            <td className="num">{x.n ? `${x.correct} of ${x.n}` : 'not in this run'}</td>
            <td className="num">{x.n ? pct(x.falseAgent) : ''}</td>
            <td className="num">{x.n ? pct(x.inconclusive) : ''}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
