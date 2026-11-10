export type Entry = {
  seq: number;
  kind: string;
  recorded_at: string;
  title: string;
  detail: string;
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
          <li key={e.seq} id={`${idPrefix}-${e.seq}`} className={cls} tabIndex={-1}>
            <span className="seq" aria-label={`Step ${e.seq}`}>
              {e.seq}
            </span>
            <div>
              <div className="t-title">
                {e.title}
                {TONE_WORD[e.tone] && e.tone !== 'money' && <span className="sr-only"> ({TONE_WORD[e.tone]})</span>}
              </div>
              {e.detail && <div className="t-detail">{e.detail}</div>}
            </div>
          </li>
        );
      })}
    </ol>
  );
}
