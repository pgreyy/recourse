# Demo reset

`npm run demo:reset -- --yes` turns the database into the clean hotel demo. Without `--yes` it only prints what it would
do. It refuses a Neon database unless `--neon` is added on purpose.

What it does, in order:

1. **Archives** the recorded scenarios and the retail set into the `demo_archive` table, once (an existing archive is
   kept as it is). The retail set is the earlier retail demo's operator, agents, saved PayPal and agreements; after
   the reset it is in the archive only and nothing on screen shows it.
2. **Wipes the test data** in one transaction: every case, order, set of buyer instructions, agent run, cart,
   snapshot, recorder entry, settlement, decision and reputation event, and every scorecard run except the latest per
   model. Pending, failed and revoked PayPal tokens go; active ones stay (PayPal returns the same vault id for the same
   payer and merchant, so they are reused).
3. **Reseeds** both catalogs (`npm run seed`: Tidewell Stays, the hotel demo, and the retail catalog the retail
   evaluation cases use) and the travel agents (`npm run seed:agents`): Wayfare Agents with Wayfare Booker v1.3 and
   v2.0, and Drift Commerce with Drift Booker v1.0 (no agreement). If Wayfare has no agreement yet, a draft is created
   (Tidewell Stays, hotel stays, 400.00 USD per incident, 1,000.00 USD in total, a 72 hour appeal window) for the
   operator to accept on the operator screen and then save its PayPal.
4. **Checks** that no real brand name appears in any table, and prints the counts.

`npm run demo:restore -- A` (or `B`) puts an archived scenario back with its original ids, together with the retail set
it needs. It adds rows only. `--check` restores inside a transaction, verifies the hash chain, every checkpoint signature
and every signature on the instructions, then rolls everything back. Archived reputation is left out unless
`--with-reputation` is given.

Run against Neon on 2026-11-10 after a full `pg_dump` backup: 2 operators (Wayfare Agents, Drift Commerce), 3 agent
versions, 31 catalog variants, no cases, the latest scorecard run per model, and 3 archived sets. `--check` restored
both archived scenarios inside a transaction with valid chains and signatures, and rolled back.
