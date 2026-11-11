# Reference: setup, API, probes

The details behind the [README](../README.md): full setup, every API route, the Phase 0 PayPal probes and the
Postman collection.

## Setup

Node 20 or later, a Postgres database (Neon works), a PayPal sandbox REST app on a **US** business
account (a sandbox business account registered outside the US failed every Vault and Orders call), and an
API key for one LLM provider (Gemini, OpenAI or Anthropic).

1. Install: `npm install`
2. Configure: `cp .env.example .env`, then fill in:
   - `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`: sandbox app credentials
   - `BUYER_EMAIL`, `OPERATOR_EMAIL`: two sandbox personal accounts
   - `DATABASE_URL`: Postgres connection string (`?sslmode=require` for Neon)
   - `AI_PROVIDER` (`gemini`, `openai` or `anthropic`), `AI_MODEL`, `AI_API_KEY`
   - Optional fallbacks: `AI_FALLBACK_MODEL` (second model, same provider), then OpenAI as the last
     resort with `OPENAI_API_KEY` and `AI_OPENAI_MODEL`. `AI_PRIMARY=openai` tries OpenAI first.
     A model that is overloaded, times out or returns a 5xx (after one retry) hands over to the next;
     the server log names the model that answered.
3. Signing key: `npm run keygen -- --append` writes `RECOURSE_SIGNING_KEY` into `.env`
   (`npm run keygen` alone prints the line instead). It signs buyer instructions; keep it secret.
4. Database: `npm run migrate` (creates the tables), then `npm run seed` (loads the demo catalogs;
   rerun it to reset availability), then `npm run seed:agents` (Wayfare Booker v1.3 and v2.0, Drift
   Booker v1.0, and a draft liability agreement for Wayfare Agents to accept on the operator screen).
5. Run the API: `npm run dev` (http://localhost:3000; `APP_PORT` changes it).
6. Webhooks (optional): expose port 3000 over https (any tunnel) and run
   `npm run webhook:register -- https://<public host>`; set the printed `WEBHOOK_ID` in `.env`.
7. Check types: `npm run typecheck`
8. Screens: `npm --prefix web install`, then `npm run web:build`; the API serves them at
   http://localhost:3000/app. For live editing run `npm run web:dev` (http://localhost:5173/app, API
   calls proxied to port 3000). `AG_STUDIO_LICENSE_KEY` in `.env` is optional; without it AG Studio
   runs in trial mode with a watermark.

Then import `postman/recourse.postman_collection.json` into Postman.

## API (Phases 1 to 6)

One Express app, organised as modules: `authorization`, `transaction`, `evidence`, `accountability`,
`settlement`, plus `paypal` (the one PayPal adapter, shared with the probes) and `shared`.

| Method and path | What it does |
|---|---|
| `POST /mandates` | `{ buyer_email, text }`: the LLM compiles plain English into strict buyer instructions, saved as `DRAFT`; anything that fails the schema is rejected (422) |
| `POST /mandates/:id/approve` | PayPal Vault setup token for the buyer; returns `approve_url` |
| `GET /mandates/:id/vault-return` | PayPal redirects here: stores the vault_id, signs the instructions (Ed25519), sets `ACTIVE` |
| `GET /mandates/:id` | The version of the instructions with `signature_valid` computed live and the remaining budget |
| `PUT /mandates/:id` | `{ text }` or `{ changes }`: creates the next version (signed again if the instructions were ACTIVE) |
| `POST /mandates/:id/revoke` | Revokes the instructions |
| `POST /operators`, `GET /operators/:id` | Agent operator and its onboarding state |
| `POST /agents`, `POST /agents/:id/versions`, `GET /agents/:id` | Agents and their versions |
| `POST /operators/:id/liability-agreement`, `GET ...`, `POST .../:version/accept`, `POST .../:version/revoke` | Versioned liability agreement (caps, covered agent versions, fault definition, appeal window); acceptance is signed |
| `POST /operators/:id/approve` | Operator's PayPal vault link, only after an agreement is accepted; the saved method is linked to it |
| `GET /operators/:id/exposure` | Caps, used and remaining |
| `POST /merchant-cart`, `PUT /merchant-cart/:id`, `GET /merchant-cart/:id` | The demo merchant's cart (`merchant_id`, default the retail one; Tidewell Stays is `tidewell-stays`) shaped like PayPal Store Sync's Cart API; each response carries a catalog snapshot |
| `POST /merchant-cart/:id/checkout` | `{ mandate_id, request_id? }`: firewall, then PayPal (saved method, payer not present) with the recorder head hash in the order description; idempotent on `request_id`; 422 `STEP_UP_REQUIRED` when the cart breaks the instructions |
| `GET /step-ups/:id/return` | Buyer approved a blocked purchase at PayPal: capture and finish |
| `GET /orders/:ref` | An order with its PayPal ids and anchor check |
| `POST /agent/run`, `GET /agent/runs/:id`, `GET /agent/versions` | Run an agent version under a set of buyer instructions (tool loop: search, cart, checkout; every step recorded). `dry_run: true` stops before PayPal; agents without an accepted operator liability agreement always get `STEP_UP_REQUIRED` |
| `GET /r/:token`, `POST /r/:token/confirm`, `POST /r/:token/report` | Receipt page (signed link): confirm (signed acknowledgement), request cancellation (`POST /r/:token/cancel`, bookings: refunded by the merchant if the rate is refundable, otherwise refused with the reason) or report an issue (opens a case) |
| `POST /webhooks/paypal` | PayPal webhooks: signature verified, deduped by event id, disputes re-read; a dispute on one of our orders opens a case |
| `POST /cases`, `GET /cases`, `GET /cases/:id`, `GET /cases/:id/evidence`, `GET /cases/:id/verify` | Cases (buyer reports and PayPal disputes), their evidence pack and code checks |
| `POST /cases/:id/assess` | Code checks, counterfactual and injection scan, then one model call, then validation in code |
| `POST /cases/:id/operator-statement` | Operator text on a case, kept as untrusted evidence and flagged if it reads like instructions |
| `POST /cases/:id/approve` | Signed decision from a validated assessment (no money moves) |
| `POST /rulings/:id/operator-accept`, `POST /rulings/:id/appeal`, `POST /appeals/:id/decide` | Operator accepts a decision (waives the appeal) or appeals it (the note goes through the injection guard); a human decides appeals |
| `GET /settlements`, `GET /settlements/:id`, `POST /settlements/:id/execute`, `POST /settlements/:id/reconcile`, `GET /cases/:id/settlement` | Settlement obligations from approved decisions: checked, executed on PayPal, confirmed by webhook; each includes `who_paid` once settled. The operator charge covers the refund plus PayPal's fee on the charge itself, so the merchant ends as after an undisputed sale (PayPal's fee on the original booking stays with the merchant); rate from PayPal's fee on the booking capture, fixed fee `PAYPAL_FEE_FIXED`; within the caps. The charge action's `calculation` and `who_paid.merchant.cash_flows` show the parts |
| `GET /agents/:id/reputation`, `GET /operators/:id/reputation` | Agent reliability, operator accountability, merchant policy (normal / step-up / suspended) |
| `POST /scorecard/run`, `GET /scorecard` | An internal, labelled evaluation set (retail and travel cases) through the same pipeline; accuracy, false AGENT_FAULT rate, INCONCLUSIVE rate, per case with its domain |
| `GET /catalog-snapshots/:id` | A stored catalog snapshot, re-hashed |
| `POST /recorder/:case_ref/entries`, `GET /recorder/:case_ref`, `GET /recorder/:case_ref/verify` | Flight recorder: hash chain with signed checkpoints |
| `GET /.well-known/recourse-signing-key` | Public key for buyer instructions, agreement acceptances and checkpoints |

Code: `src/<module>/` (API), `migrations/` (plain SQL, applied in name order by `npm run migrate`),
`data/catalog-tidewell.json` (the hotel demo catalog), `data/catalog.json` (the retail catalog behind the retail evaluation cases).

Screens (Phase 7) read through `GET /console/overview`, `/console/cases`, `/console/cases/:id`,
`/console/recovered-by-agent-version`, `/console/agents`, `/console/runs`, `/console/runs/:id`, `/console/cases/:id/operator-view` (all
read-only). `POST /agent/run` with `async: true` answers 202 as soon as the run starts. `POST
/console/clerk/turn` is the Clerk's model turn (model fixed server-side, no tools executed there).

## Probes (sandbox only)

Every probe prints PayPal's full response and appends it to `.local/logs/probes.jsonl` (access tokens
masked). Ids that the next probe needs are saved in `.local/state.json`.

| # | Command | What it does |
|---|---------|--------------|
| 1 | `npx tsx scripts/probes/01-oauth-token.ts` | OAuth token, lists the app's scopes |
| 2a | `npx tsx scripts/probes/02a-vault-setup-token.ts` | PayPal setup token, prints the approve link |
| 2b | `npx tsx scripts/probes/02b-vault-payment-token.ts` | Approved setup token to payment token, prints `vault_id` |
| 2c | `npx tsx scripts/probes/02c-vault-card-fallback.ts` | Fallback: vault a sandbox test card |
| 2d | `npx tsx scripts/probes/02d-vault-with-purchase.ts` | Fallback: save PayPal during a purchase (`store_in_vault`) |
| 3 | `npx tsx scripts/probes/03-order-vault-capture.ts` | Order with `vault_id`, payer not present; capture; check `custom_id` |
| 3b | `npx tsx scripts/probes/03b-order-buyer-present.ts` | Fallback: buyer-approved order, same `custom_id` check |
| 4a | `npx tsx scripts/probes/04a-dispute-create.ts` | Sandbox dispute as the buyer |
| 4b | `npx tsx scripts/probes/04b-dispute-get.ts` | Dispute status and every HATEOAS link |
| 4c | `npx tsx scripts/probes/04c-dispute-action.ts <rel>` | Run one dispute action, show the new status and links |
| 5 | `npm run webhook` | Webhook receiver with signature verification |
| 5b | `npx tsx scripts/probes/05b-webhook-register.ts` | Register `WEBHOOK_URL` for the four event types |
| 5c | `npx tsx scripts/probes/05c-disputes-poll.ts` | Polling fallback for disputes |
| 5d | `npx tsx scripts/probes/05d-webhook-simulate.ts` | Ask PayPal's simulator to send a sample event |
| 6 | `npx tsx scripts/probes/06-invoice-send.ts` | Invoice from the merchant to the agent operator |
| 7 | `npx tsx scripts/probes/07-refund-partial.ts` | Partial refund of a capture |
| 8 | `npx tsx scripts/probes/08-operator-charge.ts` | Charge the operator's vaulted PayPal, payer not present |

Probe 8 needs the operator vaulted first: run 2a and 2b with `--operator` and approve as the
operator sandbox account.

Webhook event types: `CUSTOMER.DISPUTE.CREATED`, `CUSTOMER.DISPUTE.UPDATED`,
`INVOICING.INVOICE.PAID`, `PAYMENT.CAPTURE.REFUNDED`.

## Postman

`postman/recourse.postman_collection.json` has one folder per phase: every PayPal sandbox call the
probes make, and every Recourse API call. Regenerate it with `npm run postman`.
