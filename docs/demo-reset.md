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

Tested on 2026-11-10 against a local copy of the database (a Postgres 18 container loaded with `pg_dump`, never Neon).
Two resets in a row both worked, and A and B restored. Their hash chains (30 and 35 entries) and every checkpoint
signature verified after the restore, and so did every mandate signature. No real brand names remained. It has not
been run against Neon.
