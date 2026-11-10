# Recourse

The liability layer for PayPal agent checkout. When an AI agent buys the wrong thing, a ruling of
agent fault, buyer remorse or merchant fault is settled on PayPal.

This repository is at **Phase 0**: one small script per PayPal sandbox call, to confirm what the
APIs return before the product is built. Results go in [docs/phase0-findings.md](docs/phase0-findings.md).

## Setup

Node 20 or later.

```
npm install
cp .env.example .env     # then fill in the sandbox values
npm run typecheck
```

Every probe prints PayPal's full response and appends it to `.local/logs/probes.jsonl`
(access tokens masked). Ids that the next probe needs are saved in `.local/state.json`.

## Probes (sandbox only)

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

`postman/recourse.postman_collection.json` holds every call above. Regenerate it with
`npm run postman`.

## License

MIT
