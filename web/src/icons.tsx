import type { ReactNode } from 'react';

// Line icons for the sidebar, 20 px, drawn on a 24 grid with a 1.75 stroke. Decorative: the label names the item.
const I = ({ children }: { children: ReactNode }) => (
  <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {children}
  </svg>
);

export const Icons = {
  operator: () => (
    <I>
      <path d="M8 4h8l1 3H7z" />
      <rect x="3.5" y="7" width="17" height="12.5" rx="1.5" />
      <path d="M9 12.5h6M9 15.5h4" />
    </I>
  ),
  buyer: () => (
    <I>
      <circle cx="12" cy="8" r="3.5" />
      <path d="M4.5 20a7.5 7.5 0 0 1 15 0" />
    </I>
  ),
  agent: () => (
    <I>
      <rect x="4" y="7" width="16" height="12" rx="2" />
      <path d="M12 3.5V7M9 12h.01M15 12h.01M9.5 15.5h5" />
    </I>
  ),
  overview: () => (
    <I>
      <rect x="3.5" y="3.5" width="7" height="7" rx="1" />
      <rect x="13.5" y="3.5" width="7" height="4.5" rx="1" />
      <rect x="13.5" y="11" width="7" height="9.5" rx="1" />
      <rect x="3.5" y="13.5" width="7" height="7" rx="1" />
    </I>
  ),
  cases: () => (
    <I>
      <path d="M3.5 7.5V18a1.5 1.5 0 0 0 1.5 1.5h14a1.5 1.5 0 0 0 1.5-1.5V9a1.5 1.5 0 0 0-1.5-1.5h-7L10 5H5a1.5 1.5 0 0 0-1.5 1.5z" />
    </I>
  ),
  caseDetail: () => (
    <I>
      <path d="M14 3.5H7A1.5 1.5 0 0 0 5.5 5v14A1.5 1.5 0 0 0 7 20.5h10a1.5 1.5 0 0 0 1.5-1.5V8z" />
      <path d="M14 3.5V8h4.5M9 12.5h6M9 16h4" />
    </I>
  ),
  agents: () => (
    <I>
      <circle cx="9" cy="8.5" r="3" />
      <path d="M3.5 19a5.5 5.5 0 0 1 11 0" />
      <circle cx="17" cy="9.5" r="2.5" />
      <path d="M16 14.2a4.5 4.5 0 0 1 4.5 4.8" />
    </I>
  ),
  settlements: () => (
    <I>
      <path d="M4 8h13l-3-3M20 16H7l3 3" />
    </I>
  ),
  scorecard: () => (
    <I>
      <path d="M4 20V10M10 20V4M16 20v-7M21 20H3" />
    </I>
  ),
  judges: () => (
    <I>
      <path d="M12 3.5 4.5 7v4.5c0 4.4 3.1 8 7.5 9 4.4-1 7.5-4.6 7.5-9V7z" />
      <path d="m9 12 2 2 4-4" />
    </I>
  ),
  clerk: () => (
    <I>
      <path d="M5 5h14a1.5 1.5 0 0 1 1.5 1.5v9A1.5 1.5 0 0 1 19 17h-8l-4.5 3.5V17H5a1.5 1.5 0 0 1-1.5-1.5v-9A1.5 1.5 0 0 1 5 5z" />
      <path d="M8 10h8M8 13h5" />
    </I>
  ),
  panel: () => (
    <I>
      <rect x="3.5" y="4.5" width="17" height="15" rx="1.5" />
      <path d="M9.5 4.5v15" />
    </I>
  ),
  menu: () => (
    <I>
      <path d="M4 7h16M4 12h16M4 17h16" />
    </I>
  ),
  close: () => (
    <I>
      <path d="M6 6l12 12M18 6 6 18" />
    </I>
  ),
  info: () => (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" aria-hidden="true">
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 11v5M12 8h.01" />
    </svg>
  ),
};
