# Order placement and save latency

Tier 3 because persistence and order-placement validation are involved.
Spec approval: not obtained (autonomous run). User targets: adding a local order
to a truck/load within 500 ms; durable plan-save acknowledgement within 5 seconds.

Measure the existing implementation first. Use read-only production diagnostics
to identify slow work; use realistic synthetic data in bounded disposable tests
for writes and repeatable browser timing. No production data in test databases.

Acceptance:

1. Clicking an available local order's Add action completes the validated local
   stop insertion and next paint within 500 ms under the recorded fixture/load.
2. A normal save reaches committed server acknowledgement within 5 seconds,
   including the autosave scheduling delay. Never show Saved before commit.
3. Complete quantities, source pickups, PO/TO dependencies, closed/restricted
   orders, cross-date assignments and driver-activity protections remain valid.
4. A changed selection/date or concurrent hydration cannot add to the wrong load
   or replace a newer draft. Unknown save results retain their frozen identity.
5. Prior source-conflict recovery and notice-size/scroll/focus tests remain green.

Use existing Node, Chromium, ESLint and disposable Compose tools. Add focused
latency/regression tests, manual fault checks for new safety boundaries, and a
concise report with measured sample sizes, limits and runtime hashes. No new
dependency or checkpoint commit is planned. Any index/schema change requires an
addendum and a bounded rehearsal before a guarded deployment.

Inspection addendum: the existing order-to-load interaction uses pointer-down
hydration followed by drag/drop, rather than an Add button. Measure from the
first pointer-down through fresh local detail retrieval, actual drag/drop
handlers, stop validation, and the next rendered frame. No frontend behavior is
changed by this patch.

Failure model: scoped reads can omit group/split members or cross-date planning
assignments; completion optimizations can choose the wrong evidence or revive a
corrected/reopened order; parallel reads can expose existing save races; broad
queries can exceed the latency budget as unrelated history grows. Cover these
with real database scope checks, canonical-projection equivalence cases,
dependency/group/reopen regressions, existing lease/source/save-race tests, and
browser timing with 36 orders, 13 trucks, 2,000 unrelated sales orders and 12,000
completion events. Runtime patches must apply cleanly over the latest deployed
image and pass again if another release changes that base. No schema changes.
