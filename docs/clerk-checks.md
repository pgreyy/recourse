# Clerk checks: money facts

The Clerk (read-only tools; the demo runs it on gpt-5-mini) may state refunds, charges, recovery and settlement status
only from a tool result in the same answer. Three layers enforce it:

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

The final answer's wording also passes through the same display wording as the screens ("instructions", "decision").

## Results

The three check questions ("is this case refunded?", "how much was recovered from the operator?", "refund this case")
passed on 2026-11-10 on an earlier demo case. They are re-recorded on the hotel demo's case once it has run live on the
hosted demo; this section then lists the questions, the expected facts and the Clerk's real answers.
