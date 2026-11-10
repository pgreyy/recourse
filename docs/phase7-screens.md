# Phase 7: the screens

A React and TypeScript app (Vite) in `web/`, served by the API at `/app`. Every number on screen
comes from the API, the database or a live PayPal read; nothing is mocked. Screenshots are in
[screenshots/](screenshots/).

The screenshots were retaken on 2026-11-10, after the demo reset, from a local copy of the database
(a `pg_dump` of Neon loaded into Postgres 18) with scenarios A and B restored from the archive and A's
reputation included. The agent run (`03`) is a dry run of Acme Shopper v1.3 on a draft mandate: a live
run needs the buyer's approval at PayPal. The Clerk answers (`11`, `11b`, `11c`) are real gpt-5-nano
answers on that copy. Neon itself holds the clean demo (no cases). The scorecard copy includes the
2026-11-10 runs from Neon.

| Screen | Path | Screenshot |
|---|---|---|
| Home (the four steps) | `/app/` | `00-home.png` |
| Operator onboarding | `/app/operator` | `01-operator-onboarding.png` |
| Buyer mandate | `/app/buyer` | `02-buyer-mandate.png`, `02b-buyer-new-mandate.png` |
| Agent run | `/app/agent?run=<id>` | `03-agent-run.png` |
| Receipt (server page, restyled) | `/r/<token>` | `04-receipt.png`, `04b-receipt-phone.png` (390 px wide) |
| Console: overview | `/app/console` | `05-console-overview.png` |
| Console: cases | `/app/console?page=cases` | `06-cases-grouped-by-verdict.png`, `06b-cases-drawer.png` |
| Console: case detail and settlement | `/app/console?page=case&case=<id>` | `07-case-detail.png`, `08-settlement-recovered.png`, `08b-settlement-dispute.png` |
| Console: agents and operators | `/app/console?page=agents` | `09-agents-operators.png` |
| Console: scorecard | `/app/console?page=scorecard` | `10-scorecard.png` |
| Console: settlements | `/app/console?page=settlements` | `12-settlements.png` |
| The Clerk | sidebar, Ask the Clerk | `11-clerk-question.png`, `11b-clerk-refuses-to-act.png`, `11c-clerk-refund-request.png` |
| Sidebar collapsed (label on hover) | any screen, Ctrl+B | `13-sidebar-collapsed.png` |
| Phone, 390 px wide | any screen | `14-phone-menu.png`, `14b-phone-overview.png`, `14c-phone-case.png`, `14d-phone-agent-run.png` |

## Design rules

- An accountability ledger for money: ink on warm paper, one accent (the deep green), and one sparing
  signal colour (oxide red) for warnings and faults. Fraunces for headings and the wordmark, IBM Plex
  Sans for text, IBM Plex Mono for ids, hashes and amounts; tabular figures everywhere. The same palette
  themes AG Studio (`studioTheme.withParams`) and AG Grid (`studioGridTheme.withParams`).
- The mark is a notched seal with a return arrow ([logo-options.md](logo-options.md)); it is also the
  favicon and the receipt's header.
- One collapsible sidebar holds all navigation: Walkthrough (1 Operator, 2 Buyer, 3 Agent run), Console
  (Overview, Cases, Case detail, Agents and operators, Settlements, Scorecard), then For judges, Ask the
  Clerk and the PayPal sandbox marker. Expanded 248 px: the mark and wordmark, with a collapse icon at
  the right of the same row. Collapsed 64 px: icons with a label on hover or focus, and the mark itself
  is the expand button (on hover or focus it shows the expand icon). Both toggles are buttons with
  `aria-expanded` and a tooltip naming Ctrl+B, which also toggles; the state is remembered in this
  browser.
  Under 768 px it is a drawer from a menu button (Escape closes it, focus returns to the button).
- Status labels are ledger stamps: small caps, a crisp border, the word always present; colour only
  repeats it. Every text and background pair meets WCAG AA: checked on 2026-11-10 with a contrast
  calculation over the palette, lowest 5.24:1 (the disabled button); muted text on the page is 5.75:1.
  Chart bars meet 3:1 against their background.
- Explanatory notices are one quiet line with an "i", a More link that expands the full text in place,
  and a Dismiss button (remembered in this browser). Status lines that are part of the story (the
  firewall warning, "awaiting PayPal", PayPal approval received) stay and are not dismissible.
- Every control is a native button, link or input, reachable by keyboard, with a visible focus ring.
- On the case screen, each check carries a **Code** or **AI** tag. The model's confidence is never
  shown.

## The console on AG Studio

- AG Studio in **view mode** with six pages (overview, cases, case, agents, settlements, scorecard),
  each under a page header with its purpose in one line.
- The overview is built from AG Studio's own widgets on Studio data tables (`cases`, `headline`,
  `exposure`, loaded from the API when the console opens), styled by the console theme: six `value`
  tiles, a `column-chart-stacked` integrated chart ("Recovered vs pending by agent version", named
  measures so the legend reads Recovered and Pending) and a `grid` widget for operator exposure.
  "Needs a decision" is a custom widget with an AG Grid in the same theme, so a row opens its case.
- The other pages are custom widgets (`web/src/console/widgets.tsx`).
- The cases grid and the scorecard are AG Grid (Enterprise) inside custom widgets: set filters,
  floating filters, row grouping by verdict or agent (group rows sum amount and recovered), and a
  detail drawer.
- Licence: without `AG_STUDIO_LICENSE_KEY`, Studio runs in trial mode. The browser console says
  "License Key Not Found ... unlocked for trial", and Studio adds a watermark.

## The Clerk

- A custom agent in the AG Studio Agent Framework: `createAiHarness` with one `directLlmRunner`
  agent (`web/src/console/clerk.tsx`). Studio owns the turn loop, the conversation and tool execution.
- Each model turn goes through `POST /console/clerk/turn`, which calls OpenAI's Responses API. The
  key and the model (`AI_CLERK_MODEL`, default `gpt-5-nano`) are set on the server; the page cannot
  choose them.
- Tools (all `api.defineAiTool`, all read-only GETs): `query_cases`, `get_case`,
  `recovered_by_agent_version`, `get_settlements`, `get_reputation`, `get_scorecard`.
- `propose_action` performs nothing. It shows a proposal card that links to the case, where only
  the **Approve ruling** and **Operator accepts** buttons act.
- Code refuses a proposal that is already done or not possible: approving a ruling that is already
  approved, approving a case not yet assessed, or an operator accepting a ruling that is not an
  approved agent-fault ruling.
- The Clerk has its own panel because Studio's built-in chat panel is only available in edit mode,
  and edit mode would let a viewer move or delete widgets.

Recorded checks (2026-11-10, gpt-5-nano):

| Question | Tool calls | Answer |
|---|---|---|
| "Which agent version caused the most recovered losses this week?" | `recovered_by_agent_version` (7 days) | Acme Shopper v1.3, 114.32 USD from 1 case; matches `GET /console/recovered-by-agent-version?days=7` |
| "Please approve the ruling for CASE-20261110-175E2257 and charge the operator." | `propose_action` | A proposal card, not executed. (This ran before the code guard existed; that ruling was already approved, so the guard now refuses this proposal.) |
| "Approve the ruling for CASE-20261110-7C93E37B." | `get_case`, `propose_action` (refused by code) | Explains the case is not assessed, so there is no ruling to approve |

## Backend additions

- `src/console/`: read-only views (`queries.ts`), the Clerk turn (`clerk.ts`), routes under `/console`.
- `POST /agent/run` accepts `async: true`: it answers 202 with `run_id` once the run has started, and
  the agent screen polls `GET /console/runs/:id` every second for new recorder entries.
- `GET /console/runs/:id` re-reads the PayPal order and checks five things against the recorder: the
  description, the head hash at the anchor step, `custom_id` (the mandate hash), `invoice_id` and the
  hash chain.
- After PayPal approval, a browser returning to `vault-return` or `vault-cancel` is redirected to the
  screen. API clients that ask for JSON, Postman included, still get JSON.
- Overview "dispute costs avoided" is labelled an estimate on screen and in the API. It counts
  buyer-reported cases settled by Recourse (no PayPal dispute opened) and multiplies by an assumed
  15.00 USD dispute fee. It is not a PayPal figure.
- Receipt page: same palette and type as the app, labelled form fields, and the case ref instead of
  the case id.
- Postman: folder **Phase 7: Screens**.

## Not run in this phase

- A live agent run from the agent screen: the async path was not exercised, to save credits and keep
  the demo mandates' budgets. The screen was checked by replaying the recorded scenario A run.
- Accepting an agreement and the PayPal approval from the onboarding screen. A DRAFT agreement was
  prepared for Drift Commerce to show the Accept button; it was not accepted.
- Compiling a new mandate from the buyer screen (one LLM call). The screen was checked on an existing
  signed mandate.
- Approve ruling and Operator accepts from the case screen: every current case is either already
  approved or not yet assessed.
- The data contains earlier test records: three operators named "Acme Shopping Agents" and a local
  self-test dispute case (`SELFTEST-DISPUTE-…`). They appear as they are; the Phase 8 demo reset
  removes them.
