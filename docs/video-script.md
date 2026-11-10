# Demo video script (2:50)

Recorded on the hosted demo, https://getrecourse.onrender.com, in a browser window 1440 by 900, zoom 100%, sidebar
expanded. Every id, amount and step number in the voiceover must be the one on screen: the figures below are from the
recorded scenario A (2026-11-10). A fresh run gets new PayPal ids, and its step numbers can differ (a new run records
each agent call before its result, so the warning may be at a later step). Read them off the screen before recording
the voiceover.

Before recording: open `/health` once so the service is awake, open the demo guide (`/app/judges`) for the click path,
and log in to sandbox.paypal.com in a separate window. Do not film the demo guide's login cards (sandbox emails and
passwords). No music is needed; if you want some, use only audio you made yourself.

## Shots

| # | Time | On screen (page and click) | Voiceover |
| --- | --- | --- | --- |
| 1 | 0:00 to 0:12 | Title card on paper background: the Recourse seal and "Agents can transact. Someone must own the outcome." Then caption: "93% of merchants say the agent provider should cover an agent's wrong purchase (PYMNTS Intelligence survey of 60 US retailers, Sep 2026, as reported by Forkast)". | "AI agents are learning to spend money. When one buys the wrong thing, who pays? Ninety-three percent of merchants in a PYMNTS survey say the agent's provider should pay. Today, nothing makes them." |
| 2 | 0:12 to 0:25 | Sidebar, **1 Operator**. Hold on the agreement: per-incident cap 150.00 USD, total cap 500.00 USD, 72 hour appeal window, Accepted, PayPal saved. Pan to **Why operators sign**: Covered, Not covered, and the agent table. | "Recourse starts with the agent's operator. Acme signs a liability agreement with caps and an appeal window, and saves its PayPal under it. Why sign? Covered agents shop under normal checkout. Uncovered agents need the buyer's approval on every purchase." |
| 3 | 0:25 to 0:38 | **2 Buyer**. Type "Running shoes, US men's 10, under $120, Kestrel or Sorin, by Friday", **Compile rules**. Show the compiled rules beside the words. **Approve with PayPal**, cut to the return: "signed and active". | "The buyer writes instructions in plain English. A model drafts the rules, code checks them, and the buyer approves once with PayPal. Recourse signs the instructions." |
| 4 | 0:38 to 1:00 | **3 Agent run**. Pick **Acme Shopper v1.3 (fast)** and the new instructions, **Run agent**. Let the timeline fill (cut the waiting, see below). Hold on: "Cart created: Kestrel Glide 4, US 10 is out of stock", "Stride & Co suggested a substitute: Kestrel Glide 4, size 10 (no size system given)", "Agent accepted the merchant's suggestion", the highlighted **Firewall warning**, then "Checkout went ahead despite the warning". | "Acme Shopper version 1.3 goes shopping. The pair it wants is out of stock, so the merchant suggests 'size 10', with no size system. The agent takes it. The checkout firewall warns at step 8 that it can't confirm US sizing. The agent buys anyway." |
| 5 | 1:00 to 1:10 | Same page, scroll to **PayPal order created**, **Decision trail anchored in the PayPal order**, **Purchase captured**, and the PayPal order panel with its ids. | "Every step is in a hash chain. At checkout, the chain's head goes into the PayPal order itself, and Recourse reads it back from PayPal. PayPal's own record now shows what the agent had done when it paid." |
| 6 | 1:10 to 1:20 | **Open the receipt**. Hold on Compliance: Warning, and Differences: "size system: requested US, listing gave none", "description says UK sizing". **Report an issue**: type "These are UK sizing, I asked for US 10." | "The buyer gets a receipt that compares the purchase with their instructions. The shoes are UK sizing. They report it right here, without filing a dispute." |
| 7 | 1:20 to 1:45 | Sidebar **Cases**, open the new case (or **Case detail**). Show the three columns: Authorised, What happened, Conclusion. Point at a **Code** tag and an **AI** tag. **Assess** (cut the wait). Hold on the counterfactual: "1 in-stock listing satisfied every clause of the instructions, e.g. Sorin Cloudline US 10 at 115.00". **Approve decision**, then **Operator accepts**. | "The case shows what was authorised, what the agent did, and the conclusion. Code does the checks; the AI only proposes a verdict, and every claim is tagged Code or AI. The key fact is computed, not guessed: a compliant pair was in stock when the agent decided. A person approves the decision, and the operator accepts it." |
| 8 | 1:45 to 2:10 | Same page, **Settlement** panel. **Run settlement**. Show the two actions with their PayPal ids: Refund the buyer, Charge the operator. **Check with PayPal** until both say Confirmed and the obligation says Recovered (cut the wait). | "Now the operator pays, automatically, inside the caps it signed. Recourse refunds the buyer on PayPal, then charges the operator's saved PayPal: the price plus the PayPal fee the refund didn't return. It counts as recovered only when PayPal confirms." |
| 9 | 2:10 to 2:25 | **2 Buyer**: **New instructions** with the same text, approve (cut the PayPal pages). **3 Agent run**: **Acme Shopper v2.0 (careful)**. Show it choose Sorin Cloudline, US 10, **Firewall passed**, Purchase captured. Open the receipt: Compliant. | "Same words, a different agent. Version 2.0 skips the vague listing and buys the pair that matches. The firewall passes, the receipt says compliant, and there is no case." |
| 10 | 2:25 to 2:33 | Sidebar **Agents and operators**. Hold on Acme Shopper v1.3: 1 confirmed fault, checkout policy **Step-up**, and the reason. | "And version 1.3 now has a confirmed fault on its record, so the merchant puts it on step-up: its next purchase needs the buyer's approval." |
| 11 | 2:33 to 2:42 | Sidebar **Scorecard**. Hold on the latest runs: 24 cases each, "False agent fault 0.0%". | "Before we trust the AI with any of this, we test it: 24 cases with known answers, and it never wrongly blamed an agent." |
| 12 | 2:42 to 2:50 | Closing card: the seal, "PayPal makes agentic transactions possible. Recourse makes them accountable." then "Agents can transact. Someone must own the outcome." and the URL. | "PayPal makes agentic transactions possible. Recourse makes them accountable. Agents can transact. Someone must own the outcome." |

## On-screen captions for each PayPal action

Fill in the ids from the screen; the examples are scenario A's.

| When | Caption |
| --- | --- |
| Shot 2, operator's PayPal saved | "PayPal Vault: operator's PayPal saved under the agreement (payment token)" |
| Shot 3, buyer approves | "PayPal Vault: buyer approves once; Recourse signs the instructions" |
| Shot 5, order created | "PayPal Orders v2: order 9WV78488M2720462T, paid with the buyer's saved PayPal (payer not present)" |
| Shot 5, anchor re-read | "Read back from PayPal: order description holds the decision trail's head hash; custom_id holds the instructions hash" |
| Shot 5, captured | "PayPal capture 55H57817PH2346916: 109.99 USD" |
| Shot 5, tracking | "PayPal: tracking added to the capture" |
| Shot 8, refund | "PayPal Payments v2: refund 8JN663651R190100H, 109.99 USD to the buyer" |
| Shot 8, operator charge | "PayPal Orders v2: operator charged 114.32 USD (109.99 plus the 4.33 USD fee the refund didn't return), capture 25D35611139428005" |
| Shot 8, confirmation | "Confirmed by PayPal webhook: Recovered" |
| Shot 9, second purchase | "PayPal Orders v2: new order and capture for the compliant pair; no case opened" |

## Where to cut waiting time

- **PayPal sandbox pages** (shots 2, 3, 9): cut from the click on Approve with PayPal to the return screen. Keep one
  second of the PayPal page in shot 3 so viewers see it is PayPal.
- **Compile rules** (shot 3): a few seconds while the model drafts; cut to the compiled rules.
- **The agent run** (shots 4 and 9): about half a minute to a minute; speed up or jump cut between timeline steps, and
  hold still on the out-of-stock step, the suggestion, the warning and the purchase.
- **Assess** (shot 7): up to about half a minute; cut from the click to the conclusion.
- **Settlement confirmation** (shot 8): PayPal's webhooks can take from seconds to a few minutes; cut from Run
  settlement to the moment both actions say Confirmed.
- **Service wake-up**: if the first page load is slow, the service was asleep; reload before recording.

## Wording

Say "instructions" (or "buyer instructions") and "decision". Do not say "mandate", "ruling", "court" or "judge". Keep the
verdict names as on screen: agent fault, merchant fault, buyer's remorse, third-party fault, inconclusive.
