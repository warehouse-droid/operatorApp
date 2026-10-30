# MBR/Agg and projected BIN planning — approved specification

Approval: user “implement plan”, following the planning decisions. The most recent
availability decision explicitly allows reuse based on saved Dispatch plans,
without waiting for Driver completion evidence. Tier 3: permissions, concurrent
allocation and source completion affect operations. This document is append-only.

## Acceptance scenarios

1. Bin1 has a saved draft return to yard 3445 at 10:00. A new pickup at 10:30
   may reserve it there; 09:30 may not. Actual custody and the prior reservation
   remain unchanged. Unscheduled releases, overlapping use, unavailable assets,
   incompatible sizes, and impossible truck/location changes are rejected.
2. Future selection shows earliest availability, projected location and predecessor
   reference. Save/assign/reselect/move/confirm revalidate this information. Editing
   or unplanning the predecessor must preserve its dependent reservations or fail
   atomically. Cross-date draft and confirmed work both count.
3. Admin and Dispatcher can create/edit/validate/activate rate cards, use their
   imports and guarded lifecycle actions, and manage assets. Other roles cannot.
   Other configuration writes, including Aggregate Routing, remain Admin-only.
   Existing immutable rates, asset custody and audit/version guards remain.
4. MBT has Delivery, Exchange, Collection and MBR/Agg tabs. The fourth lists all
   eligible SOR delivery and return orders, whole MBBS orders containing a listed
   loose aggregate item, and standalone Front Desk aggregate orders. Material
   already attached to a BIN delivery is not duplicated. Preserve original refs.
5. Admin can search the imported item catalog and maintain Aggregate Routing,
   reviewing item ID/name/unit/active status and affected orders. Seed IDs 9909,
   9910,9912,9913,9914,9915,9916,9917,9919,9921,9922. Bagged gravel is excluded by
   default. Sync preserves explicit overrides. Aggregate orders are BIN-only in
   both pools/searches and server assignment guards. Existing history remains;
   pre-existing flatbed assignments are flagged for review.
6. SOR can use flatbed or BIN, with one canonical source claim across planners.
   One bin carries one source order at a time, with multiple lines/materials.
   Grouped independent orders require ungrouping before BIN assignment.
7. A source order supports multiple trips with per-line fractional allocations;
   remaining/planned/delivered quantities are visible, over-allocation is rejected
   under concurrent requests, and completion waits for all required quantities.
   Trips retain the original reference plus Trip N; no synthetic rental/financial
   order is created. Source changes cannot silently alter started trip history.
8. Plan transport is a selected-order toolbar popup. It records bin, allocations,
   cargo weight (Dispatch supplies missing weight), pickup, dropoff and return
   yard or linked BIN delivery. Capacity is rechecked on bin/quantity changes.
   Save the route, then drag/drop into a load; no per-card action buttons.
9. Route: empty-bin pickup, cargo pickup, cargo drop, empty-bin return or linked
   delivery; travel is present where needed and same-location actions coalesce.
   Preserve source/customer locations and time windows. SOR returns collect at
   customer and return to 3445, subject to existing execution readiness. Linked
   matching BIN delivery auto-plans same load/bin, preserving required cargo.
10. Driver sees original source ref, trip quantities and physical BIN code;
    scan/photo handling and optional SOR signature rules remain. Cargo drop
    contributes to source completion before the empty bin route is finished.
    Retries/offline replay are idempotent; started/evidenced history is immutable.
11. Existing BIN numbering, exchange/dump routes, linked delivery auto-planning,
    final Collection readiness, Front Desk time windows, and card sizing remain.

## Failure model and checks

- Double reservation or allocation: transactional fleet/asset/source fencing,
  concurrent integration tests and chronological overlap properties.
- Forged role, source, revision or quantities: API authorization and adversarial
  integration tests; frozen server-owned snapshots and optimistic revisions.
- Partial write, stale plan, lost dependency: rollback and idempotent command
  tests; check both predecessor and dependent changes, including cross-date work.
- Wrong original completion or duplicate cargo: trip aggregation and replay tests,
  source ownership tests covering both planners and source sync.
- Fake physical return: assert actual custody and movement evidence stay unchanged
  when a future reservation is created; Driver separately enforces execution.
- UI/backend disagreement: isolated Chromium tests plus API tests for every role,
  source eligibility, route action, time-window lock and existing BIN regressions.
- Migration/release failure: additive migration rehearsal, narrow source overlay,
  immutable source hashes, health checks and captured rollback image.

## Setup and verification

Use existing Node/PostgreSQL/Playwright/fast-check/c8/TypeScript/ESLint tooling and
bounded disposable repository runners under mbbs-tests.slice. No new dependency,
git initialization, commit or production fixture is authorized or needed. Preserve
unrelated dirty workspace changes with a captured workspace/live baseline and a
narrow three-way overlay. Add focused tests, reusable runner commands and concise
evidence. Record RED failures, final fresh suite/static/coverage/mutation/property
results, reversed suite order, source hashes and any explicit limitations. Remove
every disposable test container/volume/network and generated test artifact after
each complete run; retain source evidence and operational rollback/audit records.

## Approved permission-policy replacement

The old Admin-only asset/rate tests used Dispatcher as their forbidden actor.
Those negative cases now use Operator or Front Desk, preserving the denial,
forged-role, capability, revision and audit assertions. The new management matrix
explicitly tests Admin and Dispatcher as allowed roles across every changed route,
and the service test imports, validates and activates a rate as Dispatcher.

## Existing browser navigation updated for the approved tabs

The old planner asserted one BIN tab and showed all action classes together.
The approved four-tab UI starts on Delivery; collection and exchange regression
tests now select their action tab before asserting visibility. The old BIN-tab
assertion is replaced with the exact four approved labels. Route, hold, evidence,
card sizing and save assertions remain unchanged.

## Browser interaction synchronization

The reversed suite exposed a detached-element failure before mouse-down in the
existing linked-delivery drag helper. Its one-shot scroll now uses Playwright's
native hover action, which waits for a stable current locator while scrolling.
Route, linked-stop count, ordering, save and unplan assertions are unchanged;
the test timeout is unchanged. Repeat this scenario five times and rerun the
complete gauntlet after this harness correction. No application code changed.

The full run showed the same initial-render race can occur between hover and a
separate bounding-box read, despite five successful focused repeats. The helper
is now replaced by one native `locator.dragTo` operation with header positions.
This retains the real cross-load drag while letting Playwright resolve its
locators within the operation. Every behavioral assertion and timeout remains.

The native single-step drag did not reach the off-screen timeline column; the
unchanged four-stop assertion caught that. The final harness retains the original
manual cross-column mouse path, awaits the optimizer save and initial network
settling before starting, and captures each visible bounding box within an
auto-wait assertion using the existing 10-second locator budget. It never retries
the drag or its route/save assertions. The application remains unchanged.

The next fresh run passed all 591 tests forward, then exposed the same unchecked
bounding-box read in the separate shared-planner browser helper (590 passed,
1 failed in reverse order). That helper now captures its source and target boxes
inside auto-wait assertions, preserving the existing 5-second source retry and
10-second target locator budgets. The mouse path and every behavioral assertion
are unchanged. Stability verification now repeats both browser scenarios five
times, followed by a fresh complete gauntlet. No application source changed.
