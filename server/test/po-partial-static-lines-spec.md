# POB03684 partial receipt static-sublist correction

Tier 3 (inventory posting). Spec approval: not obtained (autonomous run).
User authorizes fixing and deploying the receiving failure; verification must
not submit, retry, cancel or alter any live receipt or confirmation.

Failure: command de870108-fe99-4ee0-a19d-bb86b1631863 submitted 16 PO rows at
21:05 UTC. Selected REST lines 6 and 29 were correct (108 and 304 SQFT).
Thirteen deselected rows were already fully received in NetSuite. The third
open row, 33, must remain explicitly deselected. The failed external ID has no
NetSuite receipt as observed by read-only lookup.

1. Before producing a durable stored-line PO receipt draft, read current PO
   item availability once. Keep stored exact identities; merge by REST line ID
   and validate item ID, never by SKU or array position. Domain output for the
   incident must be exactly selected 6=108, selected 29=304, deselected 33.
2. Completed or closed unselected rows are omitted. Open unselected rows remain
   explicitly false, including partially received rows. New unknown open
   receivable lines must stop posting, rather than allow implicit receiving.
3. Missing selected identities, changed items, duplicate live line IDs,
   malformed receipt counters or a failed live read stop before any transform.
   Missing unselected source rows may be omitted. Preserve confirmed quantities
   without silent clamping, receipt memo/reference, location and external ID.
4. Preserve PO split lineage and parent resolution, SO/TO direct paths, kit and
   existing-pickup flows, immutable payload hashes, recovery/idempotency and
   all prior display/availability fixes. No DB source-counter repair, migration,
   dependency/configuration change or live business transaction is part of this
   release. The existing request failure is retained; the user starts a fresh
   receiving attempt after deployment.

Failure model: exact-line mismatch or repeated SKU (real incident + generated
rows); accidental receipt of unselected/new lines (wire-payload assertions and
fail-closed cases); live-read failure falling back to stale data (transport
fault tests); selected quantity change (properties); unintended SO/TO reads
(existing direct-path tests); duplicate receipt (unchanged recovery checks).

Use existing Node/PostgreSQL/fast-check/c8/ESLint/TypeScript tools. RED first,
focused and neighboring suites, static comparison, changed-line coverage,
five manual/property-only mutants, shuffled tests, full suite versus the
last verified baseline, then exact candidate and read-only live draft replay.
No git commits/resets or new dependencies. Deploy a small overlay on the current
live image after active-work preflight; retain rollback and verify hashes.
