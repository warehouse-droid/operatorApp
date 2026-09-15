# Retired order confirmation correction

Risk tier: 3 (order lifecycle and preservation of live driver work).
Spec approval: not obtained (autonomous run under the requested correction,
regression, replay and post-check).

## Acceptance scenarios

1. An active materialized SO with a retired global split definition is absent
   from the authoritative search/exact feed, catalog and order pool. The parent
   and active sibling remain available. Case differences do not bypass this.
2. An active global split returned through a canonical source row retains its
   global ownership metadata. Merely opening another plan cannot adopt it.
3. Unassigned canonical SO splits and direct local COs in an old browser draft
   are excluded from `planPayload`. Assigned records remain in the payload so
   server validation still detects an attempt to restore retired work.
4. Newly created splits, groups, explicit reactivations, and existing current-plan
   global definitions retain their existing save behavior. Legitimate source
   transit edits remain serializable. Input objects are not mutated by filtering.
5. The save validator continues rejecting retired references. No implicit
   reactivation or weakening of executed-stop/driver-activity protection.
6. Repair only the obsolete, retired direct-CO group definition for
   CO-GOA-7894-7895, after proving the canonical CO was explicitly recreated later.
   Preserve the before-image in audit and private backup. Do not change source
   orders, cargo quantities, assignments, plans or recovery drafts. A second run
   is a no-op. Cancelled COs, active groups, genuine aggregate COs and concurrent
   changes must prevent an unsafe repair.
7. Replay the original rejected recovery drafts and the latest draft on an
   isolated database copy. Use actual browser payload logic and server validation;
   report any independent driver-activity conflict without bypassing it. Prove
   that recovery snapshots and executed work remain intact.
8. Post-deployment, check app health, served source hashes, feed-to-validator
   agreement, protected retired assignment rejection, and retained recovery data.

## Failure model and evidence

- Resurrection or cargo loss: feed/validator integration, immutable input checks,
  full affected regressions, saved-draft replay, before/after database comparisons.
- Dropped unsaved work: browser payload scenarios plus randomized ownership cases.
- Partial repair: one database transaction, default rollback rehearsal, before-image
  audit, idempotence and failure rollback tests.
- Concurrent cancellation/structural edits: existing fleet/definition locks plus
  row locks, guard checks inside the transaction, contention test.
- Historical inconsistency hidden by unit mocks: real database fixtures and a
  production-data replay in an isolated database with no outbound integrations.
- Driver route overwrite: retain and exercise the executed-prefix guard; never
  force-apply an old snapshot to the active route.

## Setup and gauntlet

Use existing pinned Node, PostgreSQL, Playwright, fast-check, TypeScript and
ESLint Docker tooling; no new dependencies. Use a dedicated internal test network
and disposable database, plus a separate isolated database for production replay.
Record baseline sources before edits; preserve unrelated worktree changes and
make no commits. Persist tests, mutation runner, repair/replay tools, a single
gauntlet entrypoint and an evidence report. Run regressions, full project suites,
types, lint, changed-line coverage, mutation/property/adversarial checks, real
execution, secret/diff checks and source hashes. Record baseline failures and
unavailable layers explicitly. Deploy a selective app image under the existing
  deployment authorization; preserve the worker version.

## Additional assignment edge case

Assigned includes `orderId`, `orderRef`, and pickup `orderRefs`. A canonical
record referenced through any of these shapes must remain visible to the save
validator. The property fixture is reused across cases without changing its
assertions, to avoid repeatedly parsing the browser script.
An excluded incidental direct CO must not hide its source SO through inherited
`childOrders`; structural hiding is computed only from orders actually being saved.

The real Chromium regression also exposed direct CO cargo being treated as a
planning group during stop normalization. Direct CO source-SO references must
neither replace source stops nor hide independently assigned sources. Genuine
aggregates whose members are COs retain their collapse/hiding behavior.

Lifecycle filtering must preserve current canonical packing status and cargo.
An active definition also remains available before a materialized source row
exists; the lifecycle property covers both materialized and unmaterialized states.

## Replay-discovered timing defect

Normal plan projection refresh invalidates timing for the entire affected load,
including already executed stops. In recovery 17291, the four protected physical
stops retain identical identities/references but lose `timing`. Preserve the
published derived schedule for the executed prefix when refreshing projections,
using the existing locked-schedule overlay. Continue invalidating future route
estimates. Real changes to executed locations, order allocations or sequence
must still fail. Replay through the existing server schedule-preparation step
before invoking the repository writer, and retain the raw-draft failure evidence.

## Live activity advancing during verification

After the production replay snapshot, Driver PWA started the LOINC-033146 drop
at 13:57:15 UTC. The protected boundary advanced from stop 4 to stop 6. All six
recorded timings now survive projection refresh. A separate existing projection
changes that drop's quantity from 1500.29 to 225.89 (dependency target SOM06255-S2),
which the unchanged driver validator rejects. Post-checks must report this actual
conflict separately from the retired-order correction; do not change executed
cargo or claim live confirmation is unconditionally clear. Request the actual
physical-load state before attempting any business-data correction.
