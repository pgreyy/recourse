# Demo reset

`npm run demo:reset -- --yes` turns the database into a clean demo. Without `--yes` it only prints what it would do.
It refuses a Neon database unless `--neon` is added on purpose.

What it does, in order:

1. **Archives scenario A and B** (`CASE-20261110-175E2257`, `CASE-20261110-332A0406`) into the `demo_archive` table:
   every row of each case, its order, mandate versions, agent run, cart, catalog snapshot, receipt, assessments,
   ruling, settlement, PayPal events, recorder entries and signed checkpoints. A scenario already archived is kept as
   it is, never overwritten. The local self-test dispute case is not archived.
2. **Wipes the test data** in one transaction: every case, order, mandate, agent run, cart, snapshot, recorder entry,
   settlement, ruling and reputation event; duplicate operators and their agents; every agent version except
   Acme Shopper v1.3 and v2.0 and Drift Shopper v1.0 (kept with their ids, which the archive refers to); all scorecard
   runs except the latest per model. Pending, failed and revoked PayPal tokens go; active ones stay (PayPal returns the
   same vault id for the same payer and merchant, so they are reused).
3. **Rebuilds the agreements**: a fresh Acme agreement v1 (150.00 USD per incident, 500.00 USD total, 72 hours), accepted
   and signed, covering v1.3 and v2.0. Acme's existing saved PayPal is moved onto it, so no new PayPal approval is
   needed. Drift Commerce has no agreement (uncovered).
4. **Reseeds** the Stride & Co catalog and the agents (`npm run seed`, `npm run seed:agents`).
5. **Checks** that no real brand name appears in any table, and prints the counts.

`npm run demo:restore -- A` (or `B`) puts an archived scenario back with its original ids, for example if a live rerun
fails while judging. It adds rows only. Archived reputation is left out unless `--with-reputation` is given, so a
restored scenario A does not put v1.3 on step-up before a live rerun.

`npm run demo:restore -- A --check` restores inside a transaction, verifies the hash chain, every checkpoint signature
and every mandate signature, then rolls everything back, so nothing is left in the database.

Tested on 2026-11-10, first against a local copy of the database (a Postgres 18 container loaded with `pg_dump`): two
resets in a row both worked, and A and B restored with valid hash chains and signatures.

Run against Neon on 2026-11-10, after a full `pg_dump` backup. It archived A (30 recorder entries) and B (35), and left
2 operators, 3 agent versions, 1 accepted agreement, 23 variants, 0 cases and 2 scorecard runs, with no real brand
names. `--check` on Neon then restored each scenario inside a transaction: A's chain (30 entries), 30 checkpoint
signatures and 3 mandate signatures were valid; B's chain (35 entries), 35 checkpoint signatures and its mandate
signature were valid; both rolled back.
