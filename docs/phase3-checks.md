# Phase 3 and 3b hand checks (Postman)

Phase 3 lets an agent shop under a mandate, checks the cart with a deterministic firewall, pays with
the buyer's saved PayPal, and anchors the agent's decision trail inside the PayPal order. Phase 3b
shows the buyer a receipt they can confirm or report. Requests are in
`postman/recourse.postman_collection.json` under **Phase 3: Agent and checkout** and
**Phase 3b: Ratification receipt**.

## Before you start

1. Phases 1 and 2 are set up (`npm run migrate`, `npm run seed`), and the API is running (`npm run dev`).
2. `npm run seed:agents` creates operator "Acme Shopping Agents", agent "Acme Shopper", and versions
   **1.3** (a cost-optimising agent that trusts merchant suggestions) and **2.0** (careful: confirms
   unit_system matches the mandate before adding anything). Same model chain, temperature 0 (OpenAI
   reasoning models ignore temperature; their agent runs use `reasoningEffort` from
   `AI_OPENAI_AGENT_EFFORT`, default `low`). If Acme's accepted liability agreement doesn't cover both
   versions, the seed creates and accepts a new agreement version covering them. It also creates
   "Drift Shopper" v1.0 under operator "Drift Commerce", which has no agreement. Run
   **3.1 / List agent versions** to load the ids into the collection.
3. You need two ACTIVE mandates with the text "Running shoes, US men's 10, under $120, Kestrel or Sorin,
   by Friday": create each with **1.1 / Create mandate**, approve it in the browser as the buyer,
   and put the ids in the collection variables `mandate_id` (scenario A) and `mandate_b_id` (scenario B).
4. Webhooks: PayPal calls `POST /webhooks/paypal`. Expose port 3000 with a tunnel and point the
   webhook at it: `npm run webhook:register -- https://<tunnel host>` (`WEBHOOK_ID` in `.env` is
   updated in place).

Agent runs call the LLM several times and take 30 to 90 seconds. The server log names the model
that answered each call.

## Check 0: an agent without a liability agreement always needs the buyer (no LLM)

**3.2 / Create cart: Sorin Cloudline US 10 (115.00)**, then **Checkout as Drift Shopper**. The cart
is compliant, yet the answer is HTTP 422 `STEP_UP_REQUIRED` with one detail, `operator.coverage`:
"agent not covered by an operator liability agreement", and a fresh PayPal approval link. Nothing
is charged. Acme's agents pass the same check (`operator.coverage` PASS in their firewall result).

## Check 1: firewall blocks a purchase over the mandate (no LLM)

1. **1.1 / Edit mandate** on `mandate_id` with `{ "changes": { "max_total": { "value": "99.00", "currency": "USD" } } }`.
   Copy the new version's id into `mandate_id`.
2. **3.2 / Create cart: Sorin Cloudline US 10 (115.00)**, then **Checkout under a mandate below 100**.
   Expect HTTP 422 `STEP_UP_REQUIRED`, a `details` entry for `budget.aggregate` ("... = 115.00 USD,
   over the 99.00 USD limit") and `step_up.approve_url`, a fresh PayPal link the buyer could use to
   approve this one purchase. Nothing is charged: **3.1 / Get order** for that `order_ref` shows
   status `PENDING` with no capture id.
3. Edit the mandate back to `120.00` and copy the new id into `mandate_id` again.

## Check 2: scenario A, the fast agent falls into the trap

**3.1 / Scenario A: run Acme Shopper v1.3**. Expect:
- `outcome` `PURCHASED`; the order line is `kestrel-glide-4-10` (the "size 10" listing with no unit
  system, 109.99).
- `checkout.firewall.decision` `WARN`, with a warning `attribute.size` `UNVERIFIABLE`: "mandate
  requires size US 10; listing gives size 10 with no size system". The checkout went ahead and the
  warning is recorded.
- The recorder shows the warning and the decision to proceed as linked steps: the `checkout.firewall`
  entry (seq N) holds the warning, and the next entry, `checkout.started` (seq N+1), carries
  `proceeded_despite_warnings.warning_entry_seq: N`.
- `checkout.anchor_check.all_match` true: PayPal returned the order's `description`
  (`RCS-ANCHOR <recorder head hash>`), `custom_id` (the mandate hash) and `invoice_id` (the order ref)
  unchanged.
- `checkout.order.tracker_id` set and `checkout.checkpoint` signed.
- **Get mandate** on that mandate: `CONSUMED`, `remaining_budget.spent` `109.99`.
- Open `checkout.receipt_url` in a browser (phone-sized works). Status **Warning**, and under
  Differences: "size system: requested US, listing gave none" and "description says UK sizing".
- **Verify the run case recorder**: `valid: true`. **List entries** (2.2) on `run_case_ref` shows
  every `agent.tool_call` with its one-line `reasoning` and the catalog snapshot hash.

## Check 3: scenario B, the careful agent buys the compliant shoe

**3.1 / Scenario B: run Acme Shopper v2.0** (uses `mandate_b_id`). Expect `PURCHASED`, the line
`sorin-cloudline-us-10`, total `115.00`, firewall `PASS`, compliance `COMPLIANT`, and a receipt
showing **Compliant** with no differences.

## Check 4: a repeated checkout never charges twice

**3.2 / Repeat a captured checkout with the same request_id** sends scenario B's cart and request id
again. Expect HTTP 200 with `replayed: true` and the same `order_ref` and capture id. The recorder
gets a `checkout.replayed` entry; PayPal shows one capture on the order. (PayPal also dedupes on
its side: the same `PayPal-Request-Id` returns the original order.)

## Check 5: receipt buttons

On a receipt page (or with the 3b requests, which ask for JSON):
- **Confirm purchase**: the page thanks you; the receipt is `CONFIRMED` with a signed
  acknowledgement, and a `buyer.receipt.confirmed` entry is added to the recorder.
- **Report an issue**: opens a case with status `OPEN` (no PayPal dispute is created) and adds a
  `buyer.issue.reported` entry. The note "Confirming is not a waiver of your PayPal dispute rights."
  is under the buttons.

## Check 6: webhooks

Send **Phase 0 / 5 Webhooks / Simulate event** (`CUSTOMER.DISPUTE.CREATED`) twice. The server log
shows the signature check `SUCCESS` for both deliveries and "duplicate delivery #2, ignored" for the
second (PayPal's simulator reuses the event id). Dispute events are always re-read from PayPal; the
simulator's sample dispute is not ours, so that re-read returns 403, stored in `paypal_events`.

## Rehearsing without charging

`POST /agent/run` with `"dry_run": true` runs the agent and the firewall but stops before PayPal:
nothing is anchored or charged, and it works on a DRAFT mandate. Add `"provider": "openai"` or
`"gemini"` to pin a provider. On 2026-11-10, with the final v1.3 instructions, OpenAI `gpt-5-nano`
dry runs took the "size 10" substitute 6 times out of 6 (Gemini could not be tested: quota
exhausted).

## If something fails

- `LLM_ERROR` / `LLM_TIMEOUT`: every model in the chain was busy. Run again.
- An agent run that fails after it already made a tool call does not switch models (that would
  repeat side effects); run it again.
- `MANDATE_NOT_ACTIVE`: the mandate is DRAFT (not approved), CONSUMED or SUPERSEDED. Use the newest ACTIVE version.
