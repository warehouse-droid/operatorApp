# Load completion using NetSuite line rounding

Spec approval: not obtained (autonomous run). User authorized the fix and
specified the exact formula: Math.round((PLT*toPLT + LYR*toLYR + SEC*toSEC +
PCS*toPCS)*100)/100. The earlier proposal to extend the posting tolerance or
replace conversion with a new physical ledger is superseded by this formula.

Tier 3: incorrect completion can hide stock still to load, duplicate a load,
or leave a false remaining layer. Tests cover real partial quantities, failed
loads, existing replay protection, frontend/backend parity and SQL-backed loads.

Acceptance criteria:

1. SOA10636: 8 PLT + 5 LYR at 91.14/10.1267 maps to 779.75 SQFT;
   1 PLT + 2 LYR maps to 111.39 SQFT. Recorded loaded quantities at those
   amounts leave zero physical units in the UI and server confirmation limits.
2. Round the complete converted sum once. Keep conversions at full precision.
   Recover a whole unit only when its cumulative converted total, rounded with
   the supplied formula, exactly matches recorded SQFT rounded the same way.
   Do not use a 0.01 or 0.1 allowance to round up a physical count. EACH/PC and
   other UOMs do not acquire SQFT rounding.
3. A genuine missing layer stays missing. Zero loads stay zero. Partial loads
   keep the correct remaining pallets/layers, including historical unrounded
   SQFT values. No arbitrary rounding of physical counts or conversion factors.
4. Re-evaluate completion after each successful pickup and SO/TO delivery load,
   including grouped child loads. A line is complete only when its required
   physical units are consumed and its sales quantity is complete according to
   the SQFT line formula (other UOMs keep exact quantities). Partial order status
   stays partial until all relevant lines are complete, including other yards.
5. Local SQFT load completion uses exact line-rounding equality instead of the
   legacy 0.1 snap. The existing tests requiring 0.1 local completion are
   superseded by the user's latest exact-match instruction; replace those
   expectations with preserved shortages/rejected excess, not relaxed bounds.
6. The strictly-below-0.01 SQFT posting rule and existing IF validation, request
   count, durable retry, and successful-posting finalization remain unchanged.
   Failed validation must not change quantities or create a load audit row.
7. Correct historical display by calculation, without modifying SOA10636's
   stored order or posting another IF. Preserve other worktree changes.

Setup: use existing Node/node:test, fast-check, c8, TypeScript and ESLint; no new
dependencies, schema migration or git commits. Tests run through
docker/run-isolated-tests.sh with its unique artifact directory, bounded
mbbs-tests.slice services and unconditional teardown. Persist a reproducible
gauntlet and concise evidence; delete generated test output. If releasing,
apply only this patch over the captured live image and retain rollback/audit
records, then verify the served asset and production health.

Clarification during implementation: criterion 5 changes the local completion
snap, not the existing preflight/overpack admission policy. An initially added
test called a rounded 0.01 difference a posting excess even though its raw
converted difference was only 0.0067 and could legitimately be reconciled at
posting. Replace that test with an actual whole-layer excess and preserve
existing preflight validation. A legacy admitted 0.1 mismatch must stay partial
at the new completion check rather than being forced complete.
