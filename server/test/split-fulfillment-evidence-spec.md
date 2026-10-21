# Split fulfillment evidence correction

Tier 3: this changes which completed delivery evidence permits a NetSuite item
fulfillment. Spec approval: not obtained (autonomous run); the user identified
SOA09948-S1 as a delivered split that must post to NetSuite.

## Acceptance criteria

1. A materialized split with supplier pickup and delivery evidence on its local
   sales lines becomes queued. The snapshot retains those local line identities
   while its NetSuite parent and source line identities remain positive.
2. The equivalent direct transfer delivery uses the materialized split's local
   sales lines and exact dependency pickup and customer delivery jobs.
3. Evidence belonging to the parent or a sibling split cannot satisfy the
   completed split. Missing pickups, mismatched loads, and a different delivery
   job continue to block posting.
4. Repeat preparation produces the same snapshot and one claim per source line;
   existing posting leases and external IDs continue to prevent duplicate IFs.
5. Unsplitted orders and registered first splits without materialized children
   retain their behavior.
6. SOA09948-S1 recovery uses the existing completion candidate and the two
   delivered quantities (947.73 SQFT and 11 PC). It must not fulfill S2's lines.
   Read NetSuite before posting, verify any created fulfillment by identity and
   line quantities, and retain the result.

## Failure model and verification

- Wrong split or source line: database integration tests plus exact snapshot and
  outgoing payload assertions.
- Missing/mismatched execution evidence: negative database fixtures.
- Duplicate fulfillment or claims: repeated preparation, existing concurrency,
  service recovery, and external identity tests.
- Source drift: existing live snapshot validation remains in force; inspect the
  live order before recovery.
- Deployment overwrites another change: capture the live source, patch only the
  repository module, compare the running image again immediately before release.
- Test impact on the application host: standard isolated Compose configuration,
  bounded resources under mbbs-tests.slice, cleanup trap registered before
  launch, remove containers/volumes/networks and retain logs.

## Setup and scope

Use existing Node, PostgreSQL, test runner, c8, ESLint, and TypeScript tools.
No dependencies, migrations, credentials, production volume mounts in tests,
or changes to business quantities are required. Add a regression suite, a
reproducible bounded test runner and manual mutation runner, and release/evidence
artifacts. Preserve the pre-existing working tree; no commits are required.
Run the full affected fulfillment/posting suites, record baseline failures, and
report wider layers that are not run.
