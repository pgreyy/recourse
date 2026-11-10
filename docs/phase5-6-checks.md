# Phase 5 and 6 hand checks: settlement and reputation

Phase 5 turns an approved ruling into money moving on PayPal, separately from the ruling itself.
Phase 6 turns finalized rulings into reputation, and reputation into merchant policy. Requests are
in `postman/recourse.postman_collection.json` under **Phase 5: Settlement** and **Phase 6: Reputation**.

## How settlement works

An approved ruling creates one settlement obligation:

| Verdict | Workflow A (buyer report) | Workflow B (PayPal dispute) |
|---|---|---|
| AGENT_FAULT | Refund the buyer's capture in full, then charge the operator's saved PayPal (payer not present) | accept_claim (PayPal refunds the buyer), then charge the operator |
| MERCHANT_FAULT | Refund the buyer (the merchant pays) | make_offer (full refund) or accept_claim |
| BUYER_REMORSE | Nothing to pay | Evidence PDF filed with provide_evidence (escalating first if PayPal doesn't offer it yet) |
| THIRD_PARTY_FAULT, INCONCLUSIVE | Nobody is charged | Nobody is charged |

Before any action the executor checks:
- the ruling is approved and not appealed or reversed
- the capture isn't already refunded
- for operator recovery: the operator accepted the ruling or the appeal window ended
- the liability agreement is ACCEPTED and covers this agent version
- the operator's saved PayPal is linked to that agreement
- the per-incident cap (150) and the remaining aggregate cap (500)
- for workflow B, that PayPal currently offers the action (the dispute's own links)

Every action has an idempotency key, sha256(obligation id + action), which is also the
`PayPal-Request-Id`. The intended action is stored before the PayPal call and the response after. An
action whose outcome is uncertain (a network error) is reconciled before any retry, by repeating the
same request id or by re-reading PayPal.

The operator charge is the refunded amount plus any PayPal fee the refund did not return (read from
the capture and refund breakdowns), capped by the agreement; `custom_id` is the ruling id and
`invoice_id` the case ref. If the charge fails, an Invoicing v2 invoice goes to the operator instead.
An obligation becomes RECOVERED only when PayPal confirms: `PAYMENT.CAPTURE.COMPLETED` (or
`INVOICING.INVOICE.PAID`) by webhook, or a GET via **Reconcile** if the webhook is late. The buyer
refund never waits; operator recovery waits for `operator-accept` or the end of the 72-hour window.

## Check 1: scenario A settles end to end

1. **5.1 / Operator accepts the ruling** for ruling `64c26081-1fdc-4426-8afc-aeb989fded46`: appeal
   waived, an `obligation_id` returned.
2. **5.2 / Execute obligation**: all checks `ok`; `REFUND_BUYER` and `CHARGE_OPERATOR` SUCCEEDED,
   confirmation `pending`; status AWAITING_CONFIRMATION.
3. Within seconds both become `confirmed (webhook)` and the status RECOVERED (**Get obligation**).
4. **Operator exposure**: `used` 114.32, `remaining` 385.68.

Recorded run (2026-11-10):

| Item | Value |
|---|---|
| Buyer refund | `8JN663651R190100H`, 109.99 USD on capture `55H57817PH2346916`, confirmed by `PAYMENT.CAPTURE.REFUNDED` |
| PayPal fee not returned on the refund | 4.33 USD (capture fee minus refund fee, from PayPal's breakdowns) |
| Operator charge | order `7J227196NH989442Y`, capture `25D35611139428005`, 114.32 USD, confirmed by `PAYMENT.CAPTURE.COMPLETED` |
| Exposure after | used 114.32 of 500.00 |
| Ruling / case | SETTLED / CLOSED |

## Check 2: reputation and merchant policy

**6.1 / Agent version reputation** for Acme Shopper v1.3: `reliability` 0.511
(1 − 109.99 / 224.99 bought), `merchant_policy.policy` step-up, reason "recent confirmed agent fault".
**Operator reputation**: `accountability` 1 (1 obligation paid, 0 failed), outstanding exposure 0.
Before the settlement the same agent showed reliability 1 and policy normal: an approved ruling alone
does not count; it counts once recovered (or once an appeal is decided).

## Check 3: a step-up agent can't check out on its own

With an ACTIVE mandate and a READY cart, **6.1 / Checkout as a step-up agent** returns HTTP 422
`STEP_UP_REQUIRED` with `agent.reputation`: "recent confirmed agent fault" and a fresh PayPal approval
link. Nothing is charged.

Recorded run (2026-11-10): Acme Shopper v1.3 checking out a fully compliant cart (Sorin Cloudline US 10)
on an ACTIVE mandate got 422 with exactly one violation, `agent.reputation` "recent confirmed agent
fault". Order `RCS-20261110-347A20` stayed PENDING with no capture; the mandate's spend stayed 0.00.

## Check 4: appeals (API only)

On a ruling the operator has not accepted, within the window: **Operator appeals instead** sets the
ruling APPEALED (human review required; operator recovery on hold; the buyer refund is unaffected).
**Decide appeal**: UPHOLD restores the ruling; REVERSE marks it REVERSED, writes compensating
reputation events, and if the operator was already charged, creates and runs a REVERSAL obligation
that refunds the operator's capture.

## Check 5: workflow B, a live PayPal dispute

The buyer opens a dispute in the sandbox Resolution Center on a Recourse capture. The webhook
re-reads it, matches the order, opens a PAYPAL_DISPUTE case; then assess, approve, and execute. The
settlement view re-reads the dispute and shows PayPal's real status and links, never an assumed outcome.

Recorded run (2026-11-10), dispute **PP-R-MSF-10198047** on capture `0BM02179F5933514P` (scenario B, 115.00):

| Step | What happened (from PayPal or the recorder) |
|---|---|
| Buyer's claim | MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED: "They arrived as ordered but they just don't feel right on my feet. I changed my mind…" |
| Webhook | `CUSTOMER.DISPUTE.CREATED` (signature SUCCESS) opened case `0d78109b-9b2b-4052-af33-a24c144f27a4`, source PAYPAL_DISPUTE |
| Capture during the dispute | PENDING, reason BUYER_COMPLAINT (PayPal holds the funds) |
| Assessment (`openai/gpt-5-mini`) | BUYER_REMORSE, no violated clauses, cites the compliant purchase (firewall PASS, step 8), the buyer's signed confirmation (step 16) and the dispute (step 18); validation passed |
| Ruling | `e1e5ce15-2eba-498a-9815-35326210e15e`, liable party BUYER (approved by a human: amount above 100) |
| Execute 1 | PayPal offered make_offer, accept_claim, escalate, send_message but not provide_evidence (INQUIRY): escalated (HTTP 200) |
| PayPal, about 3 minutes later | WAITING_FOR_SELLER_RESPONSE (CHARGEBACK), now offering provide_evidence; requested seller evidence types PROOF_OF_REFUND and OTHER |
| Execute 2 | provide_evidence with `recourse-evidence.pdf` (2 pages) as OTHER: HTTP 200, debug `f500488ac13f0` |
| PayPal now | **UNDER_REVIEW (CHARGEBACK), no outcome yet**; the dispute lists the PDF as seller evidence. PayPal decides from here. |

Two problems the live run exposed, both fixed:
- A capture under dispute is PENDING (BUYER_COMPLAINT). The first assessment treated that as a failed
  amount check and went INCONCLUSIVE without a model call. The check now accepts PayPal's real hold
  and refund states and fails only on a missing or failed capture or a different amount or currency.
- The first evidence upload used PROOF_OF_FULFILLMENT and PayPal answered 400
  EVIDENCE_TYPE_IS_NOT_ALLOWED (debug `f267349a631c7`); nothing was filed. The executor now uses a type
  PayPal requested from the seller, never PROOF_OF_REFUND for a purchase that wasn't refunded.
