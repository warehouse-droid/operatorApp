# Sales delivery fulfillment at Operator loading

Tier 3: fulfillment quantities, asynchronous posting, and competing completions.
Spec approval: not obtained (autonomous run); the user's requested timing change
is the authorization. Review these acceptance criteria alongside the evidence.

1. Saving an ordinary SO delivery load atomically creates a durable IF candidate,
   without a Driver completion or a NetSuite request in the loading transaction.
2. Each candidate owns only the positive increase in cumulative loaded quantities.
   Repeated load records and later Driver completion cannot post those units again.
   Partial loads, grouped children, and split children retain their own quantities.
3. A load snapshot retains item identity and quantity. Changed/missing source lines
   require attention; mutable loaded quantities cannot rewrite a saved candidate.
4. Existing yard gates, activation boundaries, line claims, leases, external-ID
   recovery, and live NetSuite drift checks still apply. Manual IFs reconcile or
   require attention; they never justify an unbounded replacement fulfillment.
5. Driver completion still handles direct PO/TO supply and pre-cutover Operator
   quantities, subtracting quantities owned by the new load queue in every state.
6. Reload/reattempt records, customer pickup, CO, TO, and VRMA do not enter this
   new queue. Physical Driver completion and delivery status are not fabricated.
7. Admin lists show load candidates and movement history shows their verified IFs
   without a waiting-for-driver message for those loads.
8. No historical load backfill, production writes, new dependencies, git commits,
   or changes to unrelated workspace edits. Migration is additive.

Failure model: duplicate posting (delta/idempotence/property and concurrent claim
tests); lost work (transaction rollback test); incorrect source/quantity (snapshot,
split and hostile-input tests); disabled-gate bypass (cutover tests); manual IF
race (existing processor drift/recovery tests); invisible jobs (Admin/history test).

Setup: use existing Node, PostgreSQL, node:test, fast-check, ESLint, TypeScript,
and c8. Add scoped tests, migration, checks, and concise evidence. Run all tests
through the repository retention runner and standard bounded Compose services;
remove containers, databases, networks, generated source copies and logs on exit.

## User clarification (supersedes criterion 5)

Driver completion is evidence only, including direct deliveries. It creates no
IF candidate. Operator loading is the sole automatic SO IF trigger and owns only
the saved lines and quantities. Stop unattempted automatic legacy Driver jobs;
retain attempted posts and explicit Admin recovery/backfill for audit and safe
reconciliation. Do not synthesize Driver completion from loading.

## Cutover safeguard

Untouched legacy automatic Driver work must become an Admin attention item,
with an explicit reason and preserved completion evidence, rather than silently
disappearing as skipped. Already attempted transactions retain their identity,
state, and recovery path. This does not automatically replay historical loads.
Historical Admin selection is limited to retained legacy candidates; a new Driver
completion cannot be turned into a new IF through that endpoint.
