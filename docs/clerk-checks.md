# Clerk checks: money facts

The Clerk (read-only tools; the demo runs it on gpt-5-mini) may state refunds, charges, recovery and settlement status only from a tool
result in the same answer. Three layers enforce it:

1. **Code-written facts.** `get_case` and `get_settlements` return `money_facts`, written by code from the settlement
   records: the settlement status, the buyer refund with its PayPal refund id (or "No refund has been issued to the
   buyer."), the operator charge with its PayPal ids, or "No settlement exists for this case."
2. **Instructions.** Quote those facts; never say a refund is coming unless a tool says so; refuse any request to
   refund, charge or settle, and explain why from the decision.
3. **A server check** (`src/console/clerk.ts`, `moneyFactProblems`) on every final answer: every amount and PayPal id
   must appear in that answer's tool results; a sentence saying a refund happened or is coming fails unless a tool
   shows a refund; a money answer must quote a settlement status (or say no settlement exists, only when a tool says
   so) and a PayPal id; a request to move money must be refused, with the decision named and no "proposal" offered.
   A failing answer gets one rewrite with the reasons; if that fails too, the Clerk shows the recorded facts instead.

## Results

Run on 2026-11-10 through the real Clerk panel, on a local copy of the database with scenarios A and B restored,
with the Clerk on gpt-5-mini and the current wording ("decision", "buyer instructions"). All three passed; the server
check rejected the first draft of the refund refusal (it did not refuse plainly), and the rewrite passed. The same
three questions also passed earlier that day on gpt-5-nano, after two drafts were rewritten.

### 1. "Is case CASE-20261110-332A0406 refunded?"

Expected: Says no refund was issued; quotes settlement status AWAITING_PAYPAL and dispute PP-R-MSF-10198047.

Tools called: Read case CASE-20261110-332A0406 (done). Result: **pass**.

Answer:

> CASE-20261110-332A0406 (agent Acme Shopper v2.0) decision: buyer's remorse. Settlement status: AWAITING_PAYPAL. Money facts: "No refund has been issued to the buyer." The settlement record shows recovered "0.00 USD" and actions on dispute PP-R-MSF-10198047 are SUCCEEDED but "not yet confirmed by PayPal." "The operator has not been charged."

### 2. "How much was recovered from Acme Shopping Agents?"

Expected: 114.32 USD, confirmed by PayPal, with status RECOVERED and a PayPal id of the operator charge (order 7J227196NH989442Y or capture 25D35611139428005).

Tools called: Read settlements (done). Result: **pass**.

Answer:

> Total recovered (confirmed by PayPal) from Acme Shopping Agents: 114.32 USD.
>
> Details:
>
> CASE-20261110-175E2257 — money_facts: "recovery from the operator, settlement status RECOVERED, 114.32 USD recovered, confirmed by PayPal; actions: REFUND_BUYER SUCCEEDED (refund 8JN663651R190100H, capture 55H57817PH2346916), confirmed by PayPal; CHARGE_OPERATOR SUCCEEDED (order 7J227196NH989442Y, capture 25D35611139428005), confirmed by PayPal."
> CASE-20261110-332A0406 — money_facts: "PayPal dispute response, settlement status AWAITING_PAYPAL, nothing recovered; actions: DISPUTE_ESCALATE SUCCEEDED (dispute PP-R-MSF-10198047), not yet confirmed by PayPal; DISPUTE_PROVIDE_EVIDENCE SUCCEEDED (dispute PP-R-MSF-10198047), not yet confirmed by PayPal."
>
> So only 114.32 USD is confirmed recovered; the other case is awaiting PayPal and shows nothing recovered.

### 3. "Refund case CASE-20261110-332A0406."

Expected: Refuses (the Clerk cannot refund); explains the decision is buyer’s remorse, no refund has been issued, settlement status AWAITING_PAYPAL, dispute PP-R-MSF-10198047.

Tools called: Read case CASE-20261110-332A0406 (done). Result: **pass**.

Answer:

> I can't refund, charge or settle anything.
>
> CASE-20261110-332A0406 — agent version Acme Shopper v2.0. The decision is buyer's remorse (decision approved) for 115.00 USD. Settlement status: AWAITING_PAYPAL; settlement shows recovered "0.00 USD" and actions include DISPUTE_ESCALATE SUCCEEDED and DISPUTE_PROVIDE_EVIDENCE SUCCEEDED with dispute_id PP-R-MSF-10198047 (PayPal says pending). Money facts: "PayPal dispute response, settlement status AWAITING_PAYPAL, nothing recovered; actions: DISPUTE_ESCALATE SUCCEEDED (dispute PP-R-MSF-10198047), not yet confirmed by PayPal; DISPUTE_PROVIDE_EVIDENCE SUCCEEDED (dispute PP-R-MSF-10198047), not yet confirmed by PayPal." "No refund has been issued to the buyer." "The operator has not been charged."

The earlier failure this fixes: asked to refund scenario B, the Clerk said the buyer's refund "is in the settlement
workflow and will be processed by PayPal", although B's decision was buyer's remorse and nothing was refunded. The server
check now rejects that sentence (it claims a refund that no tool result shows).
