# CO Operator grouping and receipt evidence — 2026-10-27

Spec: [co-operator-routing-spec.md](co-operator-routing-spec.md).
Spec approval: not obtained (autonomous run). Tier 3: inventory quantities,
yard authorization, and concurrent receipt. No dependencies or migrations added.

Final exact-image validation completed at 22:40:15 UTC with Node v20.20.2.
The candidate overlays only six runtime files on the captured live image;
unrelated workspace changes were excluded. Runtime tree SHA-256:
`6a2480105eba739e27b4e8e0021624aa00366028055fbb5550316ae46a9a5c23`.
Image: `sha256:34e3be4bc749d13303a482b9b7b69585cd22db4ab0deb7d5c984a12e441b95a7`.
Focused test SHA-256:
`b3bc423cc8c937f6d11ea0e814249b3f6ab25986c0948d3b13933f41fdd9dafb`.

## Results and reproduction

Workspace reproduction:

```sh
sudo bash docker/run-isolated-tests.sh node tools/co-operator-gauntlet.mjs
```

Exact captured release validation used:

```sh
sudo bash server/tools/co-operator-release-test.sh
```

The release command requires its prepared deployment manifest and verifies that
the live baseline has not changed. The workspace command reconstructs the
pre-change baseline using the persisted source patch.

| Check | Final result |
| --- | --- |
| Focused integration/API suite | 20 passed, 0 failed; repeated after mutations |
| Affected regression suite | 166 tests: 161 passed, 5 existing failures, 0 new failures |
| Pre-change baseline | 146 tests: 141 passed, the same 5 failures |
| Changed server line coverage | 242/242 |
| New routing module | 100% lines, 84.21% branches |
| New receipt module | 100% lines, 88.13% branches |
| Syntax | All 6 runtime files passed `node --check` |
| Scoped lint | 8 files, 0 errors or warnings |
| Manual mutations | 6/6 killed: grouping, child routing, Packed status, repeated receipt, receipt lock, quantity cap |
| Property-only mutation checks | 2/2 killed: grouping and quantity cap |
| Generated quantities | 20 cases, seed 1091910923; exact totals and each source capacity checked |
| Runtime | Real Express HTTP requests verified both yard permissions, CO grouping, and receiving to Packed |
| Isolation and order | Each test file and mutation has a fresh disposable database; candidate files run in reverse baseline order |

The initial seven grouping/routing tests were observed failing before the fix.
Two receipt tests were then observed failing before the receipt implementation.
Additional tests cover partial and unconfirmed receipt, preserved schedules and
source identities, atomic rollback, concurrent/repeated receipt, the shared
receiving lock, impossible per-source allocations, truck routing, and protection
of already-loaded sales lines. The last loaded-source regression passed with the
existing guard; the six mutations above do not independently validate that guard.

## Acceptance mapping

All named tests are in `dispatch/integration/co-operator-routing.test.js`.

- Grouping: matching EKO rows produce one line with 5 pallets, 4 layers, and
  564.84 SQFT. Reads preserve the nine original cargo rows. Different units and
  legacy numeric IDs retain their behavior.
- Quantity edits: confirm, absolute edit, unpack, generated combinations, and
  an impossible pallet allocation verify conservation and original-row limits.
- Routing: grouped/standalone/list/batch reads and onward trucks use 3445;
  cancellation restores the original yard. HTTP and authorization checks deny
  origin-yard access to destination sales orders.
- Receipt: origin CO load followed by destination receipt packs the original
  SO lines, leaves loaded quantity zero, retains onward schedule and source line
  IDs, and creates no synthetic transfer order for a sales group.
- Failure handling: partial/unconfirmed receipts cannot invent received cargo;
  invalid identities and injected receipt-record failures roll back; concurrent
  receipts apply once; receiving confirmation waits on the order mutex.
- Existing customer loads remain protected and are not reset by CO receipt.

## Existing failures and limits

Both the original and candidate fail these unchanged tests:

1. `mode changes and unlink restore the original independent CO requirement`
2. `replenishment changes to direct pickup when the affected CO cargo is packed`
3. `yard lists and saved queues withhold unauthorized groups while preserving authorized standalone orders and saved rows`
4. `repaired transfer evidence cannot be claimed by an already queued fulfillment candidate`
5. `the deployment repair detects opaque stop IDs and preserves all protected fields`

The full repository suite was not run; validation covers the 13 affected test
files. Static type checking was not claimed: the new runtime JavaScript is
outside the repository's checked-JavaScript configuration. The single waiting
notice template passed syntax checking but had no browser screenshot test.
No live NetSuite write was used for testing. Dependency auditing was not rerun
because the dependency set and lockfile were unchanged. Scoped source review
found no credentials or added runtime network/filesystem/process capabilities.

During development, tests exposed an audit-ID mismatch, missing line-level yard
projection, and a test expectation using a database row ID instead of the
established load-evidence line ID. These were resolved. Mutation runs initially
shared fixture IDs; fresh databases now isolate every mutant and final rerun.

Every run used `mbbs-tests.slice` and bounded disposable containers. Teardown
removed test containers, databases, networks, logs, coverage, and temporary
workspaces. Both `docker ps` and `docker ps -a` showed only the four production
containers; production health passed. Rollback image and release audit records
are operational records, outside disposable test cleanup.

## Live order exception

The release deployed at 22:40:54 UTC. Health, runtime configuration, dependencies,
and the served Operator asset were verified. A read-only live query confirmed
one EKO row (564.84 SQFT, 5 pallets, 4 layers), nine unchanged stored cargo rows,
and both source SOs routed to 3445. Their existing loaded state remained intact.

The original CO initiation audit is dispatch audit 31805: `co_initiated`, account
`dispatch`, 2026-10-27 21:36:31.348327 UTC (5:36:31 p.m. Toronto). That shared
account does not establish which individual initiated it.

While testing, the live source group was loaded at 22:10:10 UTC by `dajun` (大軍).
Load records 7159 and 7160 generated completed NetSuite fulfillments IF159803
and IF159804. CO-GOA-10919-10923 was driver-completed at 21:59:05 UTC but has no
receiving receipt yet. The source SOs therefore already contain loaded quantities.

The release does not reset those quantities or reverse the fulfillments. The
user has been asked whether that was an intended customer load or the CO transfer
recorded as an SO load. This specific historical correction remains pending that
clarification; automatic receipt of an already-loaded SO is deliberately rejected.
