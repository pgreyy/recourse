# Phase 0 findings: PayPal sandbox probes

Status: **no probe has been run yet.** Each section below has a "Result" block to fill from the
probe's console output or from `.local/logs/probes.jsonl` (HTTP status, `paypal-debug-id`, key fields).

Lines marked **Docs say** come from PayPal's documentation and are not yet confirmed in our sandbox.
Lines marked **Observed** must quote a probe run (date, debug id or object id).

Sandbox app: _client id prefix only, never the secret_
Run date: _YYYY-MM-DD_

---

## 1. OAuth token

`01-oauth-token.ts` -> `POST /v1/oauth2/token`

Result:
- HTTP:
- app_id:
- expires_in:
- Scopes relevant to Recourse (the script checks these):
  - disputes:
  - invoicing:
  - vault:
  - notifications/webhooks:

## 2. Vault v3 (PayPal wallet)

`02a-vault-setup-token.ts` -> `POST /v3/vault/setup-tokens`, then approve in the browser,
then `02b-vault-payment-token.ts` -> `GET /v3/vault/setup-tokens/{id}`, `POST /v3/vault/payment-tokens`.

Result:
- Setup token id and status on create:
- Links returned (rel list):
- Status after approval (GET):
- Query params on the return URL (logged by `05-webhook-server.ts` at `/return`):
- Payment token (`vault_id`):
- `customer.id`:
- NOT_ENABLED_TO_VAULT_PAYMENT_SOURCE? yes / no

Card fallback (`02c-vault-card-fallback.ts`), only if needed:
- Setup token status on create (APPROVED without a browser step, or PAYER_ACTION_REQUIRED):
- Card `vault_id`:

## 3. Orders v2 with vault_id, payer not present

`03-order-vault-capture.ts` -> `POST /v2/checkout/orders` (Prefer: return=representation),
`POST /v2/checkout/orders/{id}/capture` if needed, `GET /v2/checkout/orders/{id}`.

Result:
- Order status straight after create (COMPLETED means it was captured on create):
- Capture call needed? yes / no
- Capture id:
- `custom_id` sent (64-char sha256 hex):
- `custom_id` on GET order purchase unit:
- `custom_id` on the capture object:
- `invoice_id` on the capture object:
- Errors (name, debug id):

## 4. Disputes

### 4a. Create (sandbox, as the buyer)

`04a-dispute-create.ts` -> `POST /v1/customer/disputes`, multipart/form-data with an `input` part
(application/json), `PayPal-Auth-Assertion` = unsigned JWT `{"alg":"none"}` / `{"iss": client_id, "email": BUYER_EMAIL}`.

**Docs say** ([Test and go live](https://developer.paypal.com/disputes/test-go-live),
[Set up accounts](https://developer.paypal.com/disputes/set-up)):
- The body field is `disputed_transactions[].buyer_transaction_id`. The buyer's transaction id is not
  the same as the merchant-side capture id. The guide gets it from the buyer's sandbox activity page.
  The probe sends the capture id by default; `DISPUTE_TXN_FIELD=seller_transaction_id` sends it under
  the seller-side field instead.
- The app needs the "Customer disputes" feature. Acting for the buyer needs the
  `https://uri.paypal.com/services/disputes/create` scope plus buyer consent (Log in with PayPal);
  the guide says to ask a PayPal account manager to add that scope.
- A buyer cannot open a second dispute on the same transaction, even after the first one closes.
  Each create attempt therefore needs a fresh capture from probe 3.

Result:
- HTTP, error name, debug id:
- Field that worked (`buyer_transaction_id` with capture id / `seller_transaction_id` / buyer id from activity page):
- Dispute id:
- Fallback used (sandbox Resolution Center as buyer)? yes / no

### 4b. Status and HATEOAS links

`04b-dispute-get.ts` prints status, stage and every link. `04c-dispute-action.ts <rel>` runs one action
through its link and prints the links at the new status. `--force` calls an action with no link to
record the error.

**Docs say:** `require-evidence` and `adjudicate` are sandbox only and need status `UNDER_REVIEW`
plus the matching link. `require-evidence` with `SELLER_EVIDENCE` moves to `WAITING_FOR_SELLER_RESPONSE`,
with `BUYER_EVIDENCE` to `WAITING_FOR_BUYER_RESPONSE`. Escalating moves the stage from `INQUIRY` to
`CHARGEBACK`. For the other actions the guide only says to check the links.

Action availability by status (fill one row per status actually seen; "link" means the rel was in `links`):

| Status (stage) | accept-claim | provide-evidence | make-offer | require-evidence | adjudicate | other rels seen | Seen in (dispute id, debug id) |
|---|---|---|---|---|---|---|---|
| | | | | | | | |
| | | | | | | | |
| | | | | | | | |
| | | | | | | | |

Forced calls without a link (error name per action and status):
-

Evidence upload limits seen (file types, size), for filing the signed mandate and receipt:
-

## 5. Webhooks

Event types subscribed: `CUSTOMER.DISPUTE.CREATED`, `CUSTOMER.DISPUTE.UPDATED`,
`INVOICING.INVOICE.PAID`, `PAYMENT.CAPTURE.REFUNDED`.

`05b-webhook-register.ts` checks each against `GET /v1/notifications/webhooks-event-types` and creates the webhook.
`05-webhook-server.ts` verifies with `POST /v1/notifications/verify-webhook-signature`.

Result:
- Each event type listed for this app? (script output):
- Webhook id:
- Events received (type, verification result, delay after the API call):
  - CUSTOMER.DISPUTE.CREATED:
  - CUSTOMER.DISPUTE.UPDATED:
  - INVOICING.INVOICE.PAID:
  - PAYMENT.CAPTURE.REFUNDED:
- Simulator events: verification result (expected FAILURE):
- Polling fallback (`05c-disputes-poll.ts`): list response shape, fields present, delay before a new dispute shows:

## 6. Invoicing v2

`06-invoice-send.ts` -> `POST /v2/invoicing/generate-next-invoice-number`, `POST /v2/invoicing/invoices`,
`POST /v2/invoicing/invoices/{id}/send`, `GET /v2/invoicing/invoices/{id}`.

Result:
- Invoice id and number:
- Status after send:
- Recipient view URL present?
- Paid as the operator sandbox account? INVOICING.INVOICE.PAID received?

## 7. Partial refund

`07-refund-partial.ts` -> `POST /v2/payments/captures/{id}/refund`, then `GET /v2/payments/captures/{id}`.

Result:
- Refund id and status:
- Capture status after refund (expected PARTIALLY_REFUNDED):
- `seller_payable_breakdown` (fee returned or not):
- PAYMENT.CAPTURE.REFUNDED received?

## 8. Operator pre-authorized liability

Vault: `02a-vault-setup-token.ts --operator`, approve as the operator, `02b-vault-payment-token.ts --operator`
(saves `OPERATOR_VAULT_ID`). Charge: `08-operator-charge.ts`.

Result:
- Operator `vault_id`:
- Order status on create, capture id:
- `custom_id` returned intact?
- Errors (name, debug id):
- Usage pattern used (`VAULT_USAGE_PATTERN`, default IMMEDIATE). Worth trying `UNSCHEDULED_POSTPAID`,
  which matches "charge later when a ruling says so":

---

## Open questions for Phase 1

- Which transaction id the sandbox dispute create accepts (see 4a).
- Whether the disputes/create scope is available to this sandbox app without an account manager.
- Whether a JSON mandate must be converted to PDF or image for `provide-evidence`.
