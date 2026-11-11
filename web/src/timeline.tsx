export type Entry = {
  key?: string;
  seq: number;
  /** A second row for the same recorded step (for example the merchant's suggested substitute). */
  sub?: boolean;
  kind: string;
  recorded_at: string;
  title: string;
  detail: string;
  evidence?: string[];
  tone: 'normal' | 'warn' | 'block' | 'money' | 'ok';
  payload: unknown;
  hash: string;
};

const TONE_WORD: Record<Entry['tone'], string> = { normal: '', warn: 'Warning', block: 'Blocked', money: 'PayPal', ok: 'Verified' };

/** The flight recorder as a vertical list. Step numbers are recorder seqs; tone is repeated as text. */
export function Timeline({ entries, highlight = [], fresh, dimAfter, idPrefix = 'step', compact }: { entries: Entry[]; highlight?: number[]; fresh?: Set<number>; dimAfter?: number; idPrefix?: string; compact?: boolean }) {
  return (
    <ol className={`timeline${compact ? ' compact' : ''}`} aria-label="Recorded steps">
      {entries.map((e) => {
        const cls = [e.tone, highlight.includes(e.seq) ? 'hl' : '', fresh?.has(e.seq) ? 'new' : '', dimAfter !== undefined && e.seq > dimAfter ? 'dim' : ''].join(' ');
        return (
          <li key={e.key ?? e.seq} id={e.sub ? undefined : `${idPrefix}-${e.seq}`} className={`${cls}${e.sub ? ' sub' : ''}`} tabIndex={e.sub ? undefined : -1}>
            <span className="seq" aria-label={e.sub ? `Also step ${e.seq}` : `Step ${e.seq}`}>
              {e.sub ? '' : e.seq}
            </span>
            <div>
              <div className="t-title">
                {e.title}
                {TONE_WORD[e.tone] && e.tone !== 'money' && <span className="sr-only"> ({TONE_WORD[e.tone]})</span>}
              </div>
              {e.detail && <div className="t-detail">{e.detail}</div>}
              {e.evidence?.length ? (
                <ul className="t-evidence" aria-label="Evidence at this step">
                  {e.evidence.map((x) => (
                    <li key={x}>{x}</li>
                  ))}
                </ul>
              ) : null}
            </div>
          </li>
        );
      })}
    </ol>
  );
}
