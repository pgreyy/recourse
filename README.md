# Recourse

The liability layer for PayPal agent checkout. When an AI agent buys the wrong thing, a ruling of
agent fault, buyer remorse or merchant fault is settled on PayPal.

Status: Phase 0 (PayPal sandbox probes, results in [docs/phase0-findings.md](docs/phase0-findings.md)),
Phase 1 (signed mandates, operators, agents) and Phase 2 (demo merchant, flight recorder).

## Setup

Node 20 or later, a Postgres database (Neon works), a PayPal sandbox REST app on a **US** business
account (see [docs/phase0-findings.md](docs/phase0-findings.md) for why the country matters), and an
API key for one LLM provider (Gemini, OpenAI or Anthropic).

1. Install: `npm install`
2. Configure: `cp .env.example .env`, then fill in:
   - `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`: sandbox app credentials
   - `BUYER_EMAIL`, `OPERATOR_EMAIL`: two sandbox personal accounts
   - `DATABASE_URL`: Postgres connection string (`?sslmode=require` for Neon)
   - `AI_PROVIDER` (`gemini`, `openai` or `anthropic`), `AI_MODEL`, `AI_API_KEY`
3. Signing key: `npm run keygen -- --append` writes `RECOURSE_SIGNING_KEY` into `.env`
   (`npm run keygen` alone prints the line instead). It signs mandates; keep it secret.
4. Database: `npm run migrate` (creates the tables), then `npm run seed` (loads the Stride & Co
   catalog from `data/catalog.json`; rerun it to reset stock).
5. Run the API: `npm run dev` (http://localhost:3000; `APP_PORT` changes it).
6. Check types: `npm run typecheck`

Then import `postman/recourse.postman_collection.json` into Postman and follow
[docs/phase1-2-checks.md](docs/phase1-2-checks.md).

## API (Phases 1 and 2)

| Method and path | What it does |
|---|---|
| `POST /mandates` | `{ buyer_email, text }`: the LLM turns plain English into a strict mandate, saved as `DRAFT` |
| `POST /mandates/:id/approve` | PayPal Vault setup token for the buyer; returns `approve_url` |
| `GET /mandates/:id/vault-return` | PayPal redirects here: stores `vault_id`, signs the mandate (Ed25519), sets `ACTIVE` |
| `GET /mandates/:id` | The mandate with `signature_valid` computed live |
| `POST /operators`, `POST /operators/:id/approve`, `GET /operators/:id` | Agent operator with a vaulted PayPal and a liability limit (default 200.00 USD) |
| `POST /agents`, `GET /agents/:id` | A named, versioned agent belonging to an operator |
| `POST /merchant-cart`, `PUT /merchant-cart/:id`, `GET /merchant-cart/:id` | Demo merchant cart shaped like PayPal Store Sync's Cart API |
| `POST /merchant-cart/:id/checkout` | 501 until Phase 3 |
| `POST /recorder/:case_ref/entries`, `GET /recorder/:case_ref`, `GET /recorder/:case_ref/verify` | Flight recorder hash chain |
| `GET /.well-known/recourse-signing-key` | Public key that verifies mandate signatures |

Code: `src/` (API), `migrations/` (plain SQL, applied in name order), `src/paypal/` (PayPal helpers
shared with the probes), `data/catalog.json` (demo catalog).

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

## License

MIT
