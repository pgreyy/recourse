# Phase 7: the screens

A React and TypeScript app (Vite) in `web/`, served by the API at `/app`. Every number on screen
comes from the API, the database or a live PayPal read; nothing is mocked. Screenshots are in
[screenshots/](screenshots/).

The screenshots were retaken on 2026-11-10, after the demo reset, from a local copy of the database
(a `pg_dump` of Neon loaded into Postgres 18) with scenarios A and B restored from the archive and A's
reputation included. The agent run (`03`) is a dry run of Acme Shopper v1.3 on a draft mandate: a live
run needs the buyer's approval at PayPal. The Clerk answers (`11`, `11b`) are real gpt-5-nano answers
on that copy. Neon itself holds the clean demo (no cases).

| Screen | Path | Screenshot |
|---|---|---|
| Operator onboarding | `/app/operator` | `01-operator-onboarding.png` |
| Buyer mandate | `/app/buyer` | `02-buyer-mandate.png`, `02b-buyer-new-mandate.png` |
| Agent run | `/app/agent?run=<id>` | `03-agent-run.png` |
| Receipt (server page, restyled) | `/r/<token>` | `04-receipt.png`, `04b-receipt-phone.png` (390 px wide) |
| Console: overview | `/app/console` | `05-console-overview.png` |
| Console: cases | `/app/console?page=cases` | `06-cases-grouped-by-verdict.png`, `06b-cases-drawer.png` |
| Console: case detail and settlement | `/app/console?page=case&case=<id>` | `07-case-detail.png`, `08-settlement-recovered.png`, `08b-settlement-dispute.png` |
| Console: agents and operators | `/app/console?page=agents` | `09-agents-operators.png` |
| Console: scorecard | `/app/console?page=scorecard` | `10-scorecard.png` |
| The Clerk | `/app/console?clerk=1` | `11-clerk-question.png`, `11b-clerk-refuses-to-act.png` |

## Design rules

- One theme: paper and ink with one accent (deep teal), IBM Plex Sans, Serif and Mono. The same
  palette themes AG Studio (`studioTheme.withParams`) and AG Grid (`studioGridTheme.withParams`).
- Status is always a text label; colour only repeats it. Every text and background pair meets WCAG
  AA (checked: the lowest is 5.04:1, muted text on the page background).
- Every control is a native button, link or input, reachable by keyboard, with a visible focus ring.
- On the case screen, each check carries a **Code** or **AI** tag. The model's confidence is never
  shown.

## The console on AG Studio

- AG Studio in **view mode** with five pages (overview, cases, case, agents, scorecard).
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
