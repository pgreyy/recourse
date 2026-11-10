# Recourse: the liability layer for agentic commerce

**Agents can transact. Someone must own the outcome.**

When an AI agent buys the wrong thing for someone, Recourse makes the agent's operator pay, automatically, within a
signed and capped agreement, on PayPal. The buyer signs a mandate, the agent shops under it, every decision is recorded
and anchored in the PayPal order, and when a purchase breaks the mandate Recourse refunds the buyer and charges the
operator's saved PayPal, up to the caps the operator accepted in advance. Disputes are the fallback, not the plan.

Shopping is the demo. Any agent that spends money on someone's behalf (travel booking, business procurement, ads,
software and data purchases) has the same gap, and Recourse's pieces are domain-neutral: the signed mandate, the
decision recorder, the snapshot of options the agent was shown, the operator's liability agreement and PayPal
settlement.

PayPal's liability model doesn't change; the merchant recovers by contract from the operator.

## Potential Impact

AI agents can now pay, but when one buys the wrong thing nobody has agreed who pays, so the merchant absorbs the
refund or the chargeback by default. 93% of merchants in a PYMNTS Intelligence survey of 60 US retailers (Sep 2026) say
the agent provider should cover losses from an agent's wrong purchase, as reported by Forkast
(https://forkast.news/the-agentic-commerce-liability-gap-who-pays-when-the-agent-buys-wrong/). Recourse gives each
party what it lacks:

- **Merchants** stop paying for agents' mistakes: the operator reimburses them by contract, through PayPal.
- **Buyers** get their money back without filing a dispute: in scenario A the refund was issued by Recourse on PayPal.
- **Operators** get something they want in return for signing: covered agents shop under normal checkout policy,
  while uncovered agents need the buyer's approval at PayPal on every purchase.

Shown working in the sandbox: an agent-fault purchase (109.99 USD, capture `55H57817PH2346916`) refunded to the buyer
(`8JN663651R190100H`) and recovered from the operator (capture `25D35611139428005`, 114.32 USD, including the
4.33 USD PayPal fee the refund did not return), both confirmed by PayPal's webhooks; the agent version then moved to
step-up, and its next checkout returned 422 with nothing charged.

## Innovation/Idea

- **Operator liability, signed, capped, auto-charged.** Existing work proves what a user authorised (Mastercard's
  Verifiable Intent, Google's AP2), gates the purchase itself (Errandly's mandate and PayPal vault consent), or defends
  merchants in disputes. Recourse moves the loss to the party that erred,
  under a versioned agreement with a per-incident cap, a total cap and an appeal window, and charges it on PayPal.
- **A counterfactual from a frozen catalog snapshot.** The catalog the agent saw is stored with its hash at the moment
  it decided. Code checks whether an in-stock listing met every clause. "A compliant alternative existed" is a computed
  fact, so the fault definition is testable.
- **The decision trail anchored in the PayPal order.** The recorder is a hash chain with signed checkpoints; at checkout
  its head hash goes into the PayPal order description and the mandate hash into `custom_id`. PayPal's own record pins
  what the agent had done when it paid.
- **Reputation that changes checkout.** Confirmed faults move an agent version from normal to step-up to suspended.

## Technological Implementation

- Express and TypeScript API in modules (authorization, transaction, evidence, accountability, settlement), Postgres on
  Neon with plain SQL migrations, React and Vite screens, AG Studio for the console.
- Deterministic checkout firewall: aggregate budget, quantity, brands, merchant, deadline, size value and size system,
  substitution, operator coverage and agent reputation. Block means a buyer-approval order at PayPal; a warning is
  recorded, and proceeding past it is recorded too.
- Assessment pipeline: 12 code checks (including a live re-read of the PayPal order and capture), the counterfactual,
  an injection scan that flags instruction-like text from merchants, buyers and operators, then one model call with
  structured output, then validation in code. Anything unproven becomes INCONCLUSIVE, never a ruling. A person approves
  every ruling; Recourse signs it.
- Settlement: pre-checks (ruling approved, operator accepted or appeal window over, agreement covers the agent version,
  caps), the intent stored before each PayPal call, an idempotency key as `PayPal-Request-Id`, reconciliation of
  uncertain outcomes, and RECOVERED only once PayPal confirms by webhook or re-read.
- Scorecard: 24 labelled cases through the same pipeline (prompt hash `223ccdc1e547`). gpt-5-mini: 23 of 24 correct,
  0% false AGENT_FAULT, 16.7% INCONCLUSIVE. gpt-5-nano: 24 of 24, 0%, 20.8%. One run each.
- The Clerk may state money facts only from its tool results: a server check compares every amount, PayPal id and
  refund claim in an answer with the tool output of that answer, asks for one rewrite, and otherwise shows the
  recorded settlement facts. Three check questions and the real answers are in `docs/clerk-checks.md`.
- A live PayPal dispute (`PP-R-MSF-10198047`) opened a case through the webhook, was assessed as buyer's remorse,
  escalated, and answered with a two page evidence PDF (`provide-evidence`, HTTP 200, debug id `f500488ac13f0`).

## Design

- Five screens in the order a story runs: operator onboarding (the agreement, caps, fault definition, the sandbox
  disclosure, Accept, then PayPal), the buyer mandate (plain English beside the compiled rules, then PayPal), the agent
  run (a live timeline that ends with the PayPal ids and the anchor check), the receipt (confirm or report an issue),
  and the console.
- The console is built on AG Studio with custom widgets: overview, a cases grid (AG Grid, grouping and filters, a
  summary drawer), the case screen in three columns (Authorised, What happened, Conclusion), each check tagged Code or
  AI, the settlement panel with every PayPal id and Confirmed or Pending, agents and operators, and the scorecard.
- The case screen opens from a cached PayPal verification and says when it last checked PayPal, with Re-verify now.
- One theme (paper, ink and one teal accent), AA contrast on every text pair, keyboard reachable, status always in
  words as well as colour.

## Presentation

The video follows the two scenarios: a covered agent buys the wrong size, the buyer reports it from the receipt, the
case shows the warning it ignored and the compliant pair it could have bought, a person approves, and PayPal refunds
the buyer and charges the operator; then a careful agent's purchase disputed on PayPal is judged buyer's remorse and
answered with evidence. Judges can repeat both on the hosted demo from `/app/judges`.

## How we used PayPal and AI

**PayPal (sandbox), every API we call:**

- **OAuth 2.0** (`/v1/oauth2/token`).
- **Vault v3** (`/v3/vault/setup-tokens`, `/v3/vault/payment-tokens`): the buyer saves PayPal for a mandate; the
  operator saves PayPal under its liability agreement.
- **Orders v2** (`/v2/checkout/orders`, `/capture`, `/track`): agent purchases with the saved PayPal, payer not
  present, carrying the anchor in `description` and `custom_id`; buyer-approval orders for blocked purchases; the
  operator charge; tracking.
- **Payments v2** (`/v2/payments/captures/{id}`, `/refund`, `/v2/payments/refunds/{id}`): buyer refunds, fee
  breakdowns, confirmation re-reads.
- **Invoicing v2** (`/v2/invoicing/invoices`, `/send`, `/generate-next-invoice-number`): the fallback when an operator
  charge fails.
- **Customer Disputes v1** (`/v1/customer/disputes/{id}` and its links: escalate, provide-evidence, accept-claim,
  make-offer): Recourse acts only on links PayPal offers.
- **Webhooks** (`/v1/notifications/webhooks`, `/v1/notifications/verify-webhook-signature`):
  `CUSTOMER.DISPUTE.CREATED`, `.UPDATED`, `.RESOLVED`, `PAYMENT.CAPTURE.COMPLETED`, `PAYMENT.CAPTURE.REFUNDED`,
  `INVOICING.INVOICE.PAID`; signatures verified, deduped by event id.
- **PayPal Server SDK** (`@paypal/paypal-server-sdk`) for Orders, Payments and Vault; the rest as REST calls.

**AI, every model and what it does:**

- **gpt-5-nano (OpenAI)** compiles the buyer's plain English into mandate rules (structured output, validated by code).
- **gpt-5-nano** runs the two demo buying agents through the Vercel AI SDK tool loop (search, cart, checkout). They are
  the agents being held accountable.
- **gpt-5-mini (OpenAI)** assesses cases: structured output, no tools, its answer validated by code, its confidence
  never shown.
- **gpt-5-nano** powers the Clerk, a custom agent in the AG Studio Agent Framework with read-only tools (cases,
  rulings, settlements, reputation, scorecard). It can propose "approve ruling X"; only the button on the case acts.
- **Gemini** (gemini-3.8-flash, then gemini-3.6-flash) is the fallback chain when OpenAI is overloaded or failing.
- **The AI has no payment tools.** Refunds, charges, invoices and dispute actions are plain code, run only after a
  person approves a ruling.

## Built with

TypeScript, Node.js 22, Express, PostgreSQL (Neon), zod, Vercel AI SDK, OpenAI gpt-5-mini and gpt-5-nano, Google
Gemini, PayPal Orders v2, Vault v3, Payments v2, Invoicing v2, Disputes, Webhooks and the PayPal Server SDK, React 19,
Vite, AG Studio (Agent Framework, custom widgets), AG Grid, Render, Postman.

## Sandbox limits, stated plainly

The operator's saved PayPal is vaulted by the demo merchant, so only that merchant can charge it (production needs a
PayPal platform or multiparty setup). The sandbox does not decide disputes, so scenario B stays under review at PayPal.
Disputes are opened by hand in the Resolution Center. The sandbox business account must be in the US.
