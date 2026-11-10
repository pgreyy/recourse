// The Recourse mark: a notched seal, for the signed agreement, with a return
// arrow inside it, for the money coming back to the right party. Readable at 16 to 20 px.
export const SEAL_POINTS = '16.00,0.60 17.84,2.02 19.99,1.12 21.40,2.97 23.70,2.66 24.58,4.81 26.89,5.11 27.19,7.42 29.34,8.30 29.03,10.60 30.88,12.01 29.98,14.16 31.40,16.00 29.98,17.84 30.88,19.99 29.03,21.40 29.34,23.70 27.19,24.58 26.89,26.89 24.58,27.19 23.70,29.34 21.40,29.03 19.99,30.88 17.84,29.98 16.00,31.40 14.16,29.98 12.01,30.88 10.60,29.03 8.30,29.34 7.42,27.19 5.11,26.89 4.81,24.58 2.66,23.70 2.97,21.40 1.12,19.99 2.02,17.84 0.60,16.00 2.02,14.16 1.12,12.01 2.97,10.60 2.66,8.30 4.81,7.42 5.11,5.11 7.42,4.81 8.30,2.66 10.60,2.97 12.01,1.12 14.16,2.02';

export function Mark({ size = 24, title }: { size?: number; title?: string }) {
  return (
    <svg viewBox="0 0 32 32" width={size} height={size} role={title ? 'img' : undefined} aria-hidden={title ? undefined : true} aria-label={title}>
      <polygon points={SEAL_POINTS} fill="#0b4f4a" stroke="#0b4f4a" strokeWidth=".8" strokeLinejoin="round" />
      <circle cx="16" cy="16" r="11.6" fill="none" stroke="#f6f3ec" strokeWidth="1.2" strokeOpacity=".6" />
      <path d="M11.6 13.3h6.5a3.85 3.85 0 0 1 0 7.7h-5.1" fill="none" stroke="#f6f3ec" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M14.6 10.3 11.6 13.3l3 3" fill="none" stroke="#f6f3ec" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
