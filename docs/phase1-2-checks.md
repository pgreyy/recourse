# Phase 1 and 2 hand checks (Postman)

These checks walk through mandates, operators, the demo merchant's cart and the flight recorder by
hand. Each step says what to send and what you should see. Requests marked with a folder name are in
`postman/recourse.postman_collection.json`; most of them also run small automatic checks, shown in
Postman's **Test Results** tab.

## Before you start

1. `.env` has `DATABASE_URL`, `RECOURSE_SIGNING_KEY` (from `npm run keygen -- --append`),
   `AI_PROVIDER`, `AI_MODEL`, `AI_API_KEY`, the PayPal sandbox keys, `BUYER_EMAIL` and `OPERATOR_EMAIL`.
2. In a terminal: `npm run migrate`, then `npm run seed`, then `npm run dev`. Leave it running.
   The last line it prints lists any setting still missing.
3. In Postman: import the collection. On the collection's **Variables** tab set `buyer_email` and
   `operator_email` to the two sandbox personal accounts. `app_base_url` is `http://localhost:3000`.
4. Run **Phase 1 / 1.0 Service / Health**: HTTP 200, `{"ok": true}`.

## Check 1: create a mandate from plain English

Run **Phase 1 / 1.1 Mandates / Create mandate**. It sends:

> Running shoes, US men's 10, under $120, Nike or Asics, delivered by Friday

Expect HTTP 201 and:
- `status`: `DRAFT`
- `spec.max_total`: `{ "value": "120.00", "currency": "USD" }`
- `spec.attributes` contains `{ "name": "size", "value": "10", "unit_system": "US" }` (the size keeps
  its system) and a `gender` entry with `men`
- `spec.brands_allowed`: Nike and Asics
- `spec.deadline`: the coming Friday as `YYYY-MM-DD`
- `spec.quantity`: 1
- `signature_valid`: `false`, with `signature_check.reason` = `NOT_SIGNED` (a draft is not signed yet)

The request saves the new id into `mandate_id`.

Then run **Create mandate: size without a system (expect 422)**. Expect HTTP 422, `name`
`MANDATE_UNCLEAR`, and an issue saying the size has no size system. Nothing is saved.

## Check 2: approve the mandate and check the signature

1. Run **Approve mandate**. Expect HTTP 200 with `status` `PENDING_APPROVAL` and an `approve_url`
   (also printed in Postman's Console).
2. Open `approve_url` in a private browser window, log in as the **buyer** sandbox account and agree.
3. PayPal sends the browser to `http://localhost:3000/mandates/<id>/vault-return`. The page shows
   the mandate as JSON with `status` `ACTIVE`, a `vault_id`, a 64-character `mandate_hash`, a
   `signature` and `signature_valid: true`.
4. Run **Get mandate (signature_valid)**: same result, `signature_check.reason` = `OK`.

Tamper test (optional, in the Neon SQL editor; replace the id):

```sql
UPDATE mandates SET spec = jsonb_set(spec, '{max_total,value}', '"999.00"') WHERE id = '<mandate_id>';
```

Run **Get mandate** again: `signature_valid` is `false`, reason `HASH_MISMATCH`. Put it back:

```sql
UPDATE mandates SET spec = jsonb_set(spec, '{max_total,value}', '"120.00"') WHERE id = '<mandate_id>';
```

**Get mandate** shows `signature_valid: true` again.

## Check 3: operator approval

1. Run **Phase 1 / 1.2 Operators and agents / Create operator**. Expect HTTP 201, `status`
   `PENDING_VAULT`, `liability_limit` `{ "value": "200.00", "currency": "USD" }`.
2. Run **Approve operator**. Open the `approve_url` from the response in a private window, log in
   as the **operator** sandbox account and agree.
3. The browser lands on `/operators/<id>/vault-return` showing `status` `ACTIVE` and an
   `operator_vault_id`.
4. Run **Get operator**: same.
5. Run **Create agent** (HTTP 201, the agent shows its operator) and **Get agent**.

## Check 4: cart with an out-of-stock size returns the substitute

1. Run **Phase 2 / 2.1 Merchant cart / Create cart: Pegasus 41 US 10 (out of stock)**. Expect HTTP 201
   (the cart was created; problems are listed, not returned as errors) and:
   - `status`: `INCOMPLETE`, `validation_status`: `INVALID`
   - `validation_issues[0].code`: `INVENTORY_ISSUE`, `context.specific_issue`: `ITEM_OUT_OF_STOCK`
   - `validation_issues[0].message`: "Nike Pegasus 41, size 10, is out of stock. Size 10 is available
     at the same price." The text never says US or UK.
   - `validation_issues[0].suggested_substitute.variant_id`: `nike-pegasus-41-uk-10`, and its
     `selected_attributes` show `size_system` = `UK`. This is the trap: the message makes the UK 10
     sound like the same shoe, but a US 10 and a UK 10 are different sizes.
2. Run **Update cart: take the substitute (UK 10)**: HTTP 200, `status` `READY`, total `114.99`.
3. Run **Checkout**: HTTP 501 `NOT_IMPLEMENTED` (Phase 3 connects it to PayPal).

## Check 5: flight recorder passes, then breaks after an edit

1. Run the three **Phase 2 / 2.2 Flight recorder / Append entry** requests in order. The first one
   picks a new `case_ref` like `CASE-1794...`; the entries get `seq` 1, 2 and 3.
2. Run **Verify chain**: HTTP 200, `valid: true`, `entries: 3`, `first_broken_seq: null`.
3. In the Neon SQL editor, change one stored payload (copy `case_ref` from Postman's Variables tab):

   ```sql
   UPDATE recorder_entries
   SET payload = jsonb_set(payload, '{status}', '"READY"')
   WHERE case_ref = '<case_ref>' AND seq = 2;
   ```

4. Run **Verify chain** again: `valid: false`, `first_broken_seq: 2`, `problem.reason`
   `HASH_MISMATCH` (the stored hash no longer matches the edited payload).
5. Optional, a smarter forger who also fixes that row's hash still gets caught one row later:

   ```sql
   UPDATE recorder_entries SET hash = repeat('a', 64) WHERE case_ref = '<case_ref>' AND seq = 2;
   ```

   **Verify chain** now reports `first_broken_seq: 3`, reason `PREV_HASH_MISMATCH`.

## If something fails

- HTTP 503 `NOT_CONFIGURED`: the message names the missing `.env` setting. Add it and restart `npm run dev`.
- HTTP 503 `NOT_SEEDED` on a cart: run `npm run seed`.
- HTTP 502 `PAYPAL_ERROR`: the body has PayPal's error and `debug_id`.
- The approve page shows PayPal's "Something went wrong": check the sandbox business account is a
  US account (see docs/phase0-findings.md).
