# Phase 0 findings: PayPal sandbox probes

Every result below quotes a probe run: HTTP status, `paypal-debug-id` and object ids, taken from
`.local/logs/probes.jsonl` (not committed). Lines marked **Docs say** come from PayPal's documentation
and are not confirmed by a run.

## Summary

| # | Probe | App 1 (NG sandbox merchant) | App 2 (US sandbox merchant) |
|---|---|---|---|
| 1 | OAuth token | Pass | Pass |
| 2 | Vault PayPal wallet (setup token) | **Fail** at buyer approval (billing agreement step) | **Pass**, vault_id `44895230px387883m` |
| 2d | Vault with purchase (fallback) | **Fail** at buyer approval | Not needed |
| 2c | Vault sandbox card (fallback) | **Fail** 403 `NOT_ENABLED_TO_VAULT_PAYMENT_SOURCE` | Not needed |
| 3 | Order with vault_id, payer not present | Not run (no vault_id) | **Pass**, `COMPLETED` on create, `custom_id` intact |
| 3b | Buyer-present order (fallback) | **Fail** at approval: merchant can't accept PayPal | Not needed |
| 4 | Dispute create by API (as buyer) | Not run (no capture) | **Fail** 400 `No permissions to set target_client_id` (both field variants) |
| 4 | Dispute via Resolution Center (fallback) + actions | Not run | **Pass**: opened by hand, picked up by 05c, actions mapped (see table) |
| 5 | Webhooks (register, receive, verify) | Pass (simulator only) | **Pass**: real dispute, refund and invoice events, all signatures `SUCCESS` |
| 6 | Invoicing (create, send, pay) | Create and send pass; payment failed | **Pass**, paid by the operator, `INVOICING.INVOICE.PAID` received |
| 7 | Partial refund | Not run (no capture) | **Pass**, `PARTIALLY_REFUNDED`, `PAYMENT.CAPTURE.REFUNDED` received |
| 8 | Operator vault + payer-not-present charge | Not run (vaulting failed) | **Pass**, vault_id `4u278207n6328905y`, charge `COMPLETED` |

Fallbacks used, in order: three vaulting attempts on app 1 (fixed body, save-with-purchase, card),
then a buyer-present order, all failed for the NG reason below; a new app on a US merchant; the
Resolution Center instead of the dispute create API; webhook simulator for `INVOICING.INVOICE.PAID`
on app 1 (on app 2 the real event arrived).

Conclusion for app 1: the sandbox business account could not take PayPal payments at all. Every
step that needed a buyer to approve something failed on PayPal's page, and card vaulting was refused
by the API. API-only calls (OAuth, setup token and order creation, invoicing, webhooks) worked.

**Root cause: the app 1 sandbox business account was registered in Nigeria (NG).** An NG business
account cannot receive PayPal payments, so every approval and payment page failed. None of the error
messages named the country. App 2 is a new app on a **US** sandbox business account with Save payment
methods, Advanced Credit and Debit Card Payments, Invoicing, Customer disputes and Transaction search
enabled; the buyer and operator are US personal accounts.

Lesson for setup: create the sandbox business account with country US (or another country that can
receive PayPal payments) before creating the app. An account that can't take payments still issues
tokens, creates setup tokens and orders, and sends invoices, so the API calls alone won't show it.

---

## App 1: first sandbox app (2026-11-10)

App id `APP-8U668758PW421843D`, merchant id `CSQGNR45CES2S`, business account country **NG**
(the root cause of every failure below; see Summary).

### 1. OAuth token: pass

`01-oauth-token.ts`, HTTP 200, debug id `f869344bd4e92`. `expires_in` 32380 s.
Scopes relevant to Recourse were all present:
- Vault: `services/vault/payment-tokens/readwrite`, `services/vault/payment-tokens/read`
- Invoicing: `services/invoicing`
- Disputes: `services/disputes/create`, `read-buyer`, `read-seller`, `update-seller`,
  `services/documents/disputes/download`
- Webhooks: `services/applications/webhooks` (not `notifications/webhooks`; the probe's check was
  corrected to this name)
- Refunds: `services/payments/refund`

Having the vault scope did not mean vaulting worked (see 2).

### 2. Vault v3: all three attempts failed

**Attempt 0** (original body). Setup token `2H157122MT847232B`, HTTP 201, debug id `f27629189f813`,
status `PAYER_ACTION_REQUIRED`, links `self` and `approve`
(`https://www.sandbox.paypal.com/agreements/approve?approval_session_id=...`).
Buyer approval showed "Something went wrong. Please go back to Recourse and choose another way to pay.
PayPal isn't available at this time." PayPal redirected to our `cancel_url` with
`approval_token_id` and `approval_session_id`. GET afterwards (debug id `f9943191713dc`): still
`PAYER_ACTION_REQUIRED`.

Body compared with [Save PayPal without purchase](https://developer.paypal.com/api/payment-tokens/save-without-purchase/paypal):
`usage_type MERCHANT`, `customer_type CONSUMER`, `usage_pattern IMMEDIATE`, `return_url`, `cancel_url`
were already correct. Missing optional fields: `shipping_preference`, `user_action`, `locale`.

**Attempt 1** (optional fields added: `shipping_preference NO_SHIPPING`, `user_action CONTINUE`,
`locale en-US`; return and cancel URLs on the https tunnel instead of `http://localhost`).
Setup token `9AU31081727039001`, HTTP 201, debug id `f198992aa9a4f`. Approval failed on desktop and
mobile at `https://www.sandbox.paypal.com/pay/generic-error?token=BA-62106997GG951733E`. The `BA-` token
shows the failure is in the billing agreement step.

**Attempt 2** (save with purchase, `02d-vault-with-purchase.ts`): order `97885266NE102803V`, HTTP 200,
debug id `f426773d84df9`, `payment_source.paypal.attributes.vault.store_in_vault ON_SUCCESS`,
`usage_type MERCHANT`. The checkout page showed "Agree and Pay" for a moment, then switched by itself
to "Return to Merchant" and redirected to our `cancel_url?token=97885266NE102803V` with no click.
GET (debug id `f6658044857e9`): still `PAYER_ACTION_REQUIRED`.

**Attempt 3** (card fallback, `02c-vault-card-fallback.ts`): HTTP 403, debug id `f378058c814c3`:
`NOT_AUTHORIZED`, issue `NOT_ENABLED_TO_VAULT_PAYMENT_SOURCE` ("The API caller or the merchant on whose
behalf the API call is initiated is not allowed to vault the given source."). No browser step reached.

**Docs say:** the merchant must be "approved and configured for billing agreements" to save PayPal;
the app needs Accept payments with Vault ticked under Advanced options; eligibility shows under
Account Settings, Payment Preferences, "Save PayPal and Venmo payment methods". PayPal wallet vaulting
may need the merchant account enabled for billing agreements / reference transactions.

### 3. Orders v2 with vault_id: not run

Blocked: no vault_id from probe 2. The fallback `03b-order-buyer-present.ts` (buyer approves, nothing
saved, same `custom_id` and `invoice_id`) created order `0YA16826WK621961C`, HTTP 200, debug id
`f817895c50465`, `custom_id` `4ffc4020e761c23618ea65a42cad36561a514150cb65cf029032d81bbf29cc5c`
(64 chars), `invoice_id` `RCS-TEST-1794307427362`. Approval as the buyer (normal window) failed with
**"The merchant isn't able to accept PayPal payments at this time."** This is what showed that the
sandbox business account itself was broken, not just its vault setup.

### 4. Disputes: not run

Blocked: no capture to dispute.

### 5. Webhooks: pass

- `05b-webhook-register.ts`: all four event types listed for the app (205 types in total). Dispute
  types listed: `CUSTOMER.DISPUTE.CREATED`, `CUSTOMER.DISPUTE.RESOLVED`, `CUSTOMER.DISPUTE.UPDATED`.
  Webhook `4JL60534DT4262925` created, HTTP 201, debug id `f4682972401d0`, URL on a cloudflared quick
  tunnel.
- `05d-webhook-simulate.ts CUSTOMER.DISPUTE.CREATED`: HTTP 202, debug id `f227399c9700c`, event
  `WH-4M0448861G563140B-9EX36365822141321`. Received through the tunnel about 10 s after the call
  (transmission 10:27:36Z, received 10:27:46Z). Signature check: **SUCCESS**.
- `05d-webhook-simulate.ts INVOICING.INVOICE.PAID`: HTTP 202, debug id `f7514439e8fb2`, event
  `WH-0T490472X6099635W-7LJ29748BW389372K`, received and verified **SUCCESS**. The simulated event
  carries PayPal's sample data (invoice `INV2-8FSD-3HT6-BRHR-UHYV`), not ours.
- Finding: events sent with `POST /v1/notifications/simulate-event` for our own `webhook_id` pass
  `verify-webhook-signature`. We had assumed simulator events could not be verified.
- Headers seen: `paypal-auth-algo SHA256withRSA`, `paypal-auth-version v2`, `paypal-cert-url`,
  `paypal-transmission-id`, `paypal-transmission-sig`, `paypal-transmission-time`.
- HATEOAS links on webhook and dispute objects use `api.sandbox.paypal.com`, not `api-m`.

### 6. Invoicing v2: create and send pass; payment failed

- `generate-next-invoice-number` needs `Content-Type: application/json` even with no body: first try
  HTTP 415 `UNSUPPORTED_MEDIA_TYPE` (debug id `f3557889c909e`); with `{}` HTTP 200, number `0001`.
- `detail.invoice_number` must be under 25 characters: HTTP 400 `INVALID_STRING_MAX_LENGTH`
  (debug id `f9908627d005c`) for a 27-character value.
- Invoice `INV2-3ZXJ-EUPF-B4FX-48BQ` created (HTTP 201, `f9972326f1ffd`, status `DRAFT`), sent
  (HTTP 200, `f574674276b36`), GET status `SENT` (`f1211967a8ab7`). Recipient view link returned.
- Paying it as the operator failed in the PayPal page: "Things don't appear to be working at the
  moment", also when logged in directly at sandbox.paypal.com. Logged as a sandbox flake at the
  time; given 3b, the broken merchant account is the likely cause. GET afterwards (`f416394d4038e`):
  still `SENT`, due 25.00 USD, no payments. No real `INVOICING.INVOICE.PAID`; the receiver path was
  proven with the simulator instead (see 5).

### 7. Partial refund: not run

Blocked: no capture.

### 8. Operator vault and charge: not run

Blocked: vaulting failed for every payment source (see 2).

### Environment notes (app 1 run)

- WSL has no IPv6 route; the cloudflared quick tunnel needed `--edge-ip-version 4`.
- WSL's DNS relay dropped lookups for `api-m.sandbox.paypal.com` for up to about 20 s at a time. The
  probes now retry network errors up to 8 times. Create calls send a `PayPal-Request-Id`, so a
  retry cannot double-create.

---

## App 2: new sandbox app (US business account, 2026-11-10)

App id `APP-3H112577TU037972W`. Buyer and operator are US sandbox personal accounts.

### 1. OAuth token: pass

HTTP 200, `expires_in` 32400 s. Same scopes as app 1, plus `services/reporting/search/read`
(Transaction search), `services/wallet/mandates/read` and `/write`, and
`services/shipping/trackers/readwrite`.

### 2. Vault v3 (PayPal wallet): pass

- `02a`: setup token `9FT28197JT837730W`, HTTP 201, debug id `f7481140c07f9`, status
  `PAYER_ACTION_REQUIRED`, links `self` and `approve`. Body as in app 1 attempt 1
  (`NO_SHIPPING`, `user_action CONTINUE`, `locale en-US`, https return and cancel URLs).
- Buyer approved in the browser. PayPal redirected to `return_url` with `approval_token_id` and
  `approval_session_id` (both equal to the setup token id).
- `02b`: GET (`f8900033a3513`) status `APPROVED`; the approved token now carries the buyer's
  `email_address` and `payer_id` (`7HM9HUGSL7TBQ`), and a `POST /v3/vault/payment-tokens` link.
- `POST /v3/vault/payment-tokens`: HTTP 201, debug id `f371224dfac7d`.
  **vault_id `44895230px387883m`**, `customer.id` `CRTXMhuogq`. The payment token also returns the
  payer's name.

### 3. Orders v2 with vault_id, payer not present: pass

- Order `3LT741927A652901J`, HTTP 201, debug id `f4956513b274a`. With `payment_source.paypal.vault_id`
  and `Prefer: return=representation`, the order came back **`COMPLETED` on create**: it was captured
  in the same call, so no capture call is needed. Capture `53F83177AT5260823`, 25.00 USD.
- GET order (`f6214437dfa0b`): `custom_id`
  `7a7b3f34bf09c0a8d31fec0be3c3390ce1d62ef8b7dbdbc0640d07ddce0c2d06` (64 chars) returned intact on the
  purchase unit and on the capture; `invoice_id` `RCS-TEST-1794308477710` returned on the capture.
- Seller protection on the capture: `ELIGIBLE`.
- A second charge for the dispute test: order `9KG7118276207533D` (`f9170199e7d85`), capture
  `0F881211A47348533`, 31.00 USD, also `COMPLETED` on create, `custom_id` intact.

### 4. Disputes

**4a. Create by API: fail (permissions).** `POST /v1/customer/disputes` with the unsigned
`PayPal-Auth-Assertion` for the buyer, multipart `input` part:
- `buyer_transaction_id` = capture id: HTTP 400, debug id `f4100501933cd`,
  `{"error":"invalid_request","error_description":"No permissions to set target_client_id"}`.
- `seller_transaction_id` = capture id: same error, debug id `f870598c6f039`.

The error rejects the auth assertion itself (acting as another account), before the body is checked,
even though the token has the `disputes/create` scope. Per the docs, this needs the buyer's consent
through Log in with PayPal, which we did not set up. Not retried further.

**Fallback: Resolution Center.** The buyer opened a dispute by hand on the 31.00 USD payment
("different or not as described", no return). Result:
- `05c-disputes-poll.ts`: empty list at 11:17:35Z (`f9670939b45e8`); the dispute appeared in the
  list at 11:20:19Z. Its `create_time` is 11:17:01Z, so it took about 3 minutes to reach the API.
- Dispute **`PP-R-HPV-10198011`**, reason `MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED`, channel
  `INTERNAL`, 31.00 USD, seller response due in 20 days.
- `disputed_transactions` carries `buyer_transaction_id` `3H377292CC492501D` (differs from our capture),
  `seller_transaction_id` `0F881211A47348533` (our capture id), and **our `custom` and
  `invoice_number`**: a dispute can be matched to its mandate without a lookup.
- The buyer's free-text claim is in `evidences[0]` (`evidence_type CREATE`, `SUBMITTED_BY_BUYER`).
- `fund_movements`: the seller was debited 29.43 USD (`HOLD_PLACED`, the 31.00 less the PayPal fee)
  as soon as the dispute opened.
- `allowed_response_options` at the start: `accept_claim` types `PARTIAL_REFUND`, `REFUND_WITH_RETURN`,
  `REFUND`; `make_offer` types `REFUND`, `REFUND_WITH_RETURN`.
- The list endpoint and the single GET disagreed for a moment: the list showed `UNDER_REVIEW`, the GET
  `WAITING_FOR_SELLER_RESPONSE` with `dispute_state REQUIRED_ACTION`.

**4b/4c. Dispute actions by status** (dispute `PP-R-HPV-10198011`; statuses re-read every 10 s until
stable). Rel names come back with underscores (`accept_claim`), the paths with hyphens
(`/accept-claim`).

| # | Status (stage, dispute_state) | Links offered | accept_claim | provide_evidence | make_offer | require_evidence | adjudicate | Action taken, result |
|---|---|---|---|---|---|---|---|---|
| 1 | WAITING_FOR_SELLER_RESPONSE (INQUIRY, REQUIRED_ACTION) | self, make_offer, accept_claim, escalate, send_message | yes | no | yes | no | no | `send_message` HTTP 200 (`f225491f6ea73`) |
| 2 | UNDER_REVIEW (INQUIRY), seconds only | self | no | no | no | no | no | passing state after each action |
| 3 | WAITING_FOR_BUYER_RESPONSE (INQUIRY, REQUIRED_OTHER_PARTY_ACTION) | self, send_message, accept_claim, escalate | yes | no | no | no | no | `escalate` by the merchant, HTTP 200 (`f579782b65d5a`) |
| 4 | UNDER_REVIEW (INQUIRY, UNDER_PAYPAL_REVIEW), about 2 min | self | no | no | no | no | no | forced `require-evidence` SELLER_EVIDENCE: HTTP 400 `ACTION_NOT_ALLOWED_IN_CURRENT_DISPUTE_STATE` (`f121334170ceb`) |
| 5 | WAITING_FOR_SELLER_RESPONSE (CHARGEBACK, REQUIRED_ACTION) | self, accept_claim, provide_evidence | yes | yes | no | no | no | `provide-evidence` with a PDF, HTTP 200 (`f556168b4e0ca`) |
| 6 | UNDER_REVIEW (CHARGEBACK, UNDER_PAYPAL_REVIEW) | self, provide_supporting_info | no | no | no | no | no | forced `adjudicate` BUYER_FAVOR: HTTP 400 `ACTION_NOT_ALLOWED_IN_CURRENT_DISPUTE_STATE` (`f888682448d6a`) |

Observations:
- A merchant `send_message` in INQUIRY handed the turn to the buyer (row 1 to row 3).
- After the merchant's `escalate`, the stage stayed `INQUIRY` for about 2 minutes, then moved to
  `CHARGEBACK` and back to the seller (row 4 to row 5). The docs say escalation moves the stage to
  `CHARGEBACK`; here it did so with a delay. The forced `require-evidence` call came seconds before the
  change but was refused, so it did not cause it (not certain).
- **`require_evidence` and `adjudicate` links never appeared**, at any status, for this
  Resolution Center dispute, and forcing them was refused. The docs say they need `UNDER_REVIEW` plus
  the link. So for a dispute opened by a buyer in the Resolution Center we could not drive it to
  `RESOLVED` from the API; it now waits on PayPal's review. Whether API-created sandbox disputes get
  these links is still open (dispute create by API was blocked, see 4a).
- `make_offer` and `accept_claim` were offered but not executed: either one would have ended the walk.
- Merchant `escalate` notes are stored as an `OTHER` evidence from the seller.
- Evidence upload: multipart, `input` part (application/json) plus a file part named `evidence-file`;
  a 946-byte PDF was accepted and listed under `evidences[].documents` with a download URL.
  `evidence_type ITEM_DESCRIPTION` was stored as `OTHER`.
- Last seen state: `UNDER_REVIEW` / `UNDER_PAYPAL_REVIEW`, stage `CHARGEBACK`, no outcome yet.

### 5. Webhooks: pass, real events

Webhook `3UK44528K93627400` (HTTP 201, `f889224864a83`), same four event types, cloudflared quick
tunnel. Every event below verified **SUCCESS** with `verify-webhook-signature`.

| Event | PayPal created | Received | Resource |
|---|---|---|---|
| CUSTOMER.DISPUTE.CREATED (simulator) | sample | 11:02:17Z | sample `PP-000-042-663-135` |
| PAYMENT.CAPTURE.REFUNDED | 11:02:19Z | 11:02:30Z | refund `0LS076900W798532B`, with our `custom_id` and `invoice_id`, `up` link to the capture |
| CUSTOMER.DISPUTE.CREATED | 11:20:33Z | 11:20:37Z | `PP-R-HPV-10198011` (dispute created 11:17:01Z) |
| CUSTOMER.DISPUTE.UPDATED x6 | 11:21:03Z to 11:27:03Z | 4 to 5 s later each | one per status change in the table above |
| CUSTOMER.DISPUTE.UPDATED | (update_time 11:38:53Z) | 11:39:07Z | no visible change, see below |
| INVOICING.INVOICE.PAID | 11:34:27Z | 11:34:40Z | `INV2-95DU-ZMNU-CT6S-QVAH`, `PAID`, payment `5CG923857M910110W` |

- Delivery took 4 to 13 s after PayPal created the event. The first dispute event came about 3.5 min
  after the buyer opened the case, at the same time the dispute showed up in the list API.
- Dispute events are created on PayPal's half-minute marks (hh:mm:03, hh:mm:33): they appear to be
  batched.
- The polling fallback (`05c`) saw every status change the webhooks reported, within one 30 s poll.
- An update can carry no visible change: `CUSTOMER.DISPUTE.UPDATED` `WH-24334080YE1725529-9YJ00749NW824753J`
  arrived at 11:39:07Z (verified SUCCESS), but a GET right after (debug id `ca584c6837962`) showed the
  same status (`UNDER_REVIEW`), state (`UNDER_PAYPAL_REVIEW`), stage (`CHARGEBACK`), links,
  `fund_movements` and evidences as before; only `update_time` moved (11:38:53Z). Phase 1 should not
  treat every update event as a new status: re-read the dispute and compare with the last stored copy.

### 6. Invoicing v2: pass

- Invoice `INV2-95DU-ZMNU-CT6S-QVAH`, number `0001` (the counter is per merchant, so it restarted),
  HTTP 201 (`f2758194547fe`), sent HTTP 200 (`f572493de2bc9`), GET `SENT` (`f2094736748d7`).
- Paid by the operator sandbox account through the recipient view link. `INVOICING.INVOICE.PAID`
  carried status `PAID`, `paid_amount` 25.00 USD, payment `5CG923857M910110W` (method `PAYPAL`), due
  0.00, and our `detail.reference` (`RCS-CASE-TEST-...`), so a payment maps back to its case.

### 7. Partial refund: pass

- `POST /v2/payments/captures/53F83177AT5260823/refund`, 5.00 USD: HTTP 201, debug id `f665314dbfa3d`,
  refund `0LS076900W798532B` `COMPLETED`. The refund carries the capture's `custom_id` and `invoice_id`.
- `seller_payable_breakdown`: gross 5.00, `paypal_fee` 0.00, net 5.00: on a partial refund PayPal keeps
  its fee (the capture's fee was 1.36 on 25.00); the merchant pays the full refunded amount.
- GET capture (`f49482896f6fa`): status `PARTIALLY_REFUNDED`, `refund` link still present.

### 8. Operator pre-authorized liability: pass

- Vault: `02a --operator` setup token `77712185R0432912N` (`f95332429f1c7`), approved in the browser as
  the operator (GET shows the operator's email and payer id `E64V894FBP228`); `02b --operator`
  payment token HTTP 201 (`ca584c10ccff2`): **OPERATOR_VAULT_ID `4u278207n6328905y`**,
  customer `SkjzwGOeMX`.
- Charge: `08-operator-charge.ts`, order `85112230PB687624W`, HTTP 201 (`f25066730600a`), `COMPLETED`
  on create, capture `15N61886AS292183E`, 25.00 USD. `custom_id`
  `65362f1fe504427a5cc562cc5d13ef17e4306233a8524b6b10a7f27e8df24671` and `invoice_id`
  `RCS-TEST-1794310532654` returned intact (`f3569349b9d9c`).
- `usage_pattern IMMEDIATE` was enough for a later payer-not-present charge. `UNSCHEDULED_POSTPAID`
  was not tried.

---

## Open questions for Phase 1

- Dispute create by API needs buyer consent (Log in with PayPal with the `disputes/create` scope) to
  get past `No permissions to set target_client_id`. Until then, test disputes come from the
  Resolution Center.
- Whether API-created sandbox disputes offer `require_evidence` and `adjudicate` links; Resolution
  Center disputes did not, so we can't force a ruling outcome in the sandbox yet.
- Which `evidence_type` values PayPal keeps (ours was stored as `OTHER`), and the file type and size
  limits for evidence.
- Whether a JSON mandate needs to be rendered to PDF for evidence (a PDF worked).
- Whether `UNSCHEDULED_POSTPAID` is accepted for the operator's vault and changes anything.
