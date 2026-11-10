# Logo options

Recourse is a signed agreement, and the money comes back to the right party. Three directions were drawn as 32 by 32
SVG marks in the app's deep green on paper, and checked at 128, 32, 20 and 16 pixels (the collapsed sidebar shows the
mark at 20 pixels; the favicon at 16).

| | Option | Rationale |
| --- | --- | --- |
| <img src="logo/option-a-seal.svg" width="64" alt="Option A"> | **A. Seal with a return arrow** (default) | A notched seal reads as a signed, stamped agreement; the arrow turning back inside it is the money returning. It stays legible at 16 pixels. |
| <img src="logo/option-b-r-return.svg" width="64" alt="Option B"> | B. An R whose leg turns back | The name's initial with the return built into its stroke; distinctive large, but the leg and arrow blur together below 20 pixels. |
| <img src="logo/option-c-loop.svg" width="64" alt="Option C"> | C. Two marks closing a loop | Buyer and operator as two arrows that complete a cycle; clear at every size, but it reads as a generic refresh icon. |

The default is **A**. To swap, replace the mark in `web/src/brand.tsx` (the app and its favicon) and in
`src/accountability/receipts.routes.ts` (the receipt page) with the SVG of another option.

The wordmark is set in Fraunces, a soft semi-serif, at weight 600. Headings use Fraunces too; body text is IBM Plex
Sans; ids, hashes and amounts are IBM Plex Mono with tabular figures.

## SVG source

Option A (default):

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" role="img" aria-label="Recourse mark: a seal with a return arrow"> <polygon points="16.00,0.60 17.84,2.02 19.99,1.12 21.40,2.97 23.70,2.66 24.58,4.81 26.89,5.11 27.19,7.42 29.34,8.30 29.03,10.60 30.88,12.01 29.98,14.16 31.40,16.00 29.98,17.84 30.88,19.99 29.03,21.40 29.34,23.70 27.19,24.58 26.89,26.89 24.58,27.19 23.70,29.34 21.40,29.03 19.99,30.88 17.84,29.98 16.00,31.40 14.16,29.98 12.01,30.88 10.60,29.03 8.30,29.34 7.42,27.19 5.11,26.89 4.81,24.58 2.66,23.70 2.97,21.40 1.12,19.99 2.02,17.84 0.60,16.00 2.02,14.16 1.12,12.01 2.97,10.60 2.66,8.30 4.81,7.42 5.11,5.11 7.42,4.81 8.30,2.66 10.60,2.97 12.01,1.12 14.16,2.02" fill="#0b4f4a" stroke="#0b4f4a" stroke-width=".8" stroke-linejoin="round"/> <circle cx="16" cy="16" r="11.6" fill="none" stroke="#f6f3ec" stroke-width="1.2" stroke-opacity=".6"/> <path d="M11.6 13.3h6.5a3.85 3.85 0 0 1 0 7.7h-5.1" fill="none" stroke="#f6f3ec" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/> <path d="M14.6 10.3 11.6 13.3l3 3" fill="none" stroke="#f6f3ec" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/> </svg>
```

Option B:

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" role="img" aria-label="Recourse mark: an R whose leg turns back into a return arrow"> <rect width="32" height="32" rx="7" fill="#0b4f4a"/> <path d="M10.5 24.5V7.5h6.8a4.6 4.6 0 0 1 0 9.2h-6.8" fill="none" stroke="#f6f3ec" stroke-width="2.6" stroke-linejoin="round"/> <path d="M15.6 16.7 20.8 21.6a1.9 1.9 0 0 1-1.3 3.3H14" fill="none" stroke="#f6f3ec" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/> <path d="M16.6 22.3 14 24.9l2.6 2.6" fill="none" stroke="#f6f3ec" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/> </svg>
```

Option C:

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" role="img" aria-label="Recourse mark: two marks closing a loop"> <rect width="32" height="32" rx="16" fill="#0b4f4a"/> <path d="M8.6 15.4a7.4 7.4 0 0 1 12.6-5" fill="none" stroke="#f6f3ec" stroke-width="2.5" stroke-linecap="round"/> <path d="M21.8 7.2l-.4 3.5-3.5-.3" fill="none" stroke="#f6f3ec" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round"/> <path d="M23.4 16.6a7.4 7.4 0 0 1-12.6 5" fill="none" stroke="#9fd1c8" stroke-width="2.5" stroke-linecap="round"/> <path d="M10.2 24.8l.4-3.5 3.5.3" fill="none" stroke="#9fd1c8" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round"/> </svg>
```

Inline, for viewers that render SVG in Markdown:

<svg width="48" height="48" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" role="img" aria-label="Recourse mark: a seal with a return arrow"> <polygon points="16.00,0.60 17.84,2.02 19.99,1.12 21.40,2.97 23.70,2.66 24.58,4.81 26.89,5.11 27.19,7.42 29.34,8.30 29.03,10.60 30.88,12.01 29.98,14.16 31.40,16.00 29.98,17.84 30.88,19.99 29.03,21.40 29.34,23.70 27.19,24.58 26.89,26.89 24.58,27.19 23.70,29.34 21.40,29.03 19.99,30.88 17.84,29.98 16.00,31.40 14.16,29.98 12.01,30.88 10.60,29.03 8.30,29.34 7.42,27.19 5.11,26.89 4.81,24.58 2.66,23.70 2.97,21.40 1.12,19.99 2.02,17.84 0.60,16.00 2.02,14.16 1.12,12.01 2.97,10.60 2.66,8.30 4.81,7.42 5.11,5.11 7.42,4.81 8.30,2.66 10.60,2.97 12.01,1.12 14.16,2.02" fill="#0b4f4a" stroke="#0b4f4a" stroke-width=".8" stroke-linejoin="round"/> <circle cx="16" cy="16" r="11.6" fill="none" stroke="#f6f3ec" stroke-width="1.2" stroke-opacity=".6"/> <path d="M11.6 13.3h6.5a3.85 3.85 0 0 1 0 7.7h-5.1" fill="none" stroke="#f6f3ec" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/> <path d="M14.6 10.3 11.6 13.3l3 3" fill="none" stroke="#f6f3ec" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/> </svg>
<svg width="48" height="48" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" role="img" aria-label="Recourse mark: an R whose leg turns back into a return arrow"> <rect width="32" height="32" rx="7" fill="#0b4f4a"/> <path d="M10.5 24.5V7.5h6.8a4.6 4.6 0 0 1 0 9.2h-6.8" fill="none" stroke="#f6f3ec" stroke-width="2.6" stroke-linejoin="round"/> <path d="M15.6 16.7 20.8 21.6a1.9 1.9 0 0 1-1.3 3.3H14" fill="none" stroke="#f6f3ec" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/> <path d="M16.6 22.3 14 24.9l2.6 2.6" fill="none" stroke="#f6f3ec" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/> </svg>
<svg width="48" height="48" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" role="img" aria-label="Recourse mark: two marks closing a loop"> <rect width="32" height="32" rx="16" fill="#0b4f4a"/> <path d="M8.6 15.4a7.4 7.4 0 0 1 12.6-5" fill="none" stroke="#f6f3ec" stroke-width="2.5" stroke-linecap="round"/> <path d="M21.8 7.2l-.4 3.5-3.5-.3" fill="none" stroke="#f6f3ec" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round"/> <path d="M23.4 16.6a7.4 7.4 0 0 1-12.6 5" fill="none" stroke="#9fd1c8" stroke-width="2.5" stroke-linecap="round"/> <path d="M10.2 24.8l.4-3.5 3.5.3" fill="none" stroke="#9fd1c8" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round"/> </svg>
