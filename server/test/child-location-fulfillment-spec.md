# Child-location outbound fulfillment

Approved: user accepted the proposed plan and requested implementation, 2026-09-18.
Verification tier: old-coder Tier 3 (inventory, authorization, durable retries).

## Acceptance scenarios

1. NetSuite location 14 has parent 1. An operator assigned yard 1 can find,
   prepare and confirm SOB120598; its fulfillment line retains location 14.
2. All active descendants of 1, 28, 15 and 26 inherit outbound yard access and
   posting switches. Nested descendants work. Unknown/inactive locations,
   ancestry cycles and other yards fail closed. Receiving/returns stay strict.
3. Mixed parent/child lines use one IF per source SO whenever accepted. A
   confirmed mixed-location rejection, with no existing original IF, permits
   durable parts grouped by exact location. No quantity or location changes.
4. Timeout, transport failure, unrecognized validation, permission or inventory
   errors never trigger a split. An existing original IF is verified/recovered.
5. Each part has a deterministic external ID and an immutable payload. A
   restart, duplicate request or lost parent lease cannot post a part twice.
   Only pending or definitively rejected parts can be attempted again.
6. Parent posting completes after all parts verify. Results and recovery UI
   retain every IF reference and its locations; old single-IF jobs still work.
7. Customer pickup and driver-completion posting share the same behavior and
   canonical REST line identities. Existing posting switches remain unchanged.
8. Refreshes include child lines without marking unrelated source lines missing.

## Failure model and checks

- Wrong-yard access / unknown ancestry: unit, property, HTTP integration tests.
- Wrong stock location / duplicated quantity: payload and read-back assertions.
- Duplicate posting / partial completion: injected failures, restart and races.
- Ambiguous commit: original and part external-ID recovery; no second transform.
- Migration or legacy-job damage: isolated PostgreSQL upgrade/rollback checks.
- Missed runtime wiring / stale PWA: real isolated HTTP execution and UI checks.

## Setup

Use existing Docker Node/PostgreSQL and browser images and installed test tools.
No new dependencies or git commits. Capture pre-change workspace for baseline and
release patching; preserve unrelated edits and live deployment changes. Persist
test runner, mutation checks and evidence in this repository. No test fulfillment
is posted to production; account-specific acceptance is observed on normal user
confirmation unless a suitable sandbox is available.

## Explicit live-test authorization (2026-09-18)

The user subsequently requested: "use SOB120598 as an acutal test, if passed all
regression and real test to netsuite, then deploy". This supersedes the initial
no-production-test setup constraint for SOB120598 only. After regression checks,
refresh its source lines, inspect existing fulfillments and outstanding quantity,
post its authorized fulfillment through the candidate implementation with a
durable deterministic external ID, then read back and verify source, canonical
REST line, actual location and quantity. Deployment requires this check to pass.
Do not repeat a successful test fulfillment or delete real transaction evidence.

## Regression fixture alignment

Existing yard authorization properties moved only an order header while retaining
its old inventory-line yard. Move both in those fixtures so the existing expected
allow/deny assertions still describe a single-yard order. The new C3/C7/H3 tests
separately require denial of mismatched foreign inventory lines. NetSuite transport
fixtures must answer the active location-directory read. Replace the old literal
`tl.location = 1` query assertion with the exact authorized descendant set
`tl.location IN (1,14)`; preserve the foreign-location rejection and no-import
assertions. This is the intended child-location query contract, not a wider grant.
