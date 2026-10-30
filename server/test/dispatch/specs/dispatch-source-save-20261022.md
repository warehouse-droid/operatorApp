# Source refresh saves and stable notices

Tier 3: concurrency and draft preservation. Spec approval: not obtained
(autonomous run). Existing Node, Playwright, ESLint and TypeScript tooling only;
no dependencies, database migrations, or checkpoint commits.

Observed: plan 367 revision 37 was followed two seconds later by source acceptance
revision 38. Only one order's cargo fields changed; trucks and summary did not.
The browser starts source-review reads during save completion, then drops their
patch while `saveInFlight` is true. Later saves permanently fence the tab.

Acceptance criteria:

1. A source-review response after a save acknowledgement applies its complete
   source patch and corresponding fence even while the save queue is finishing.
2. A missed source acknowledgement can recover only with the exact original
   revision/digest and a contiguous archive of source-only transitions. Changed
   routes, plan status, summary, other edits, gaps, or wrong digests cannot qualify.
3. Applying a proven source refresh retains local stop ordering, assignments,
   notes, unrelated orders, and newer local generations. Concurrent changes to
   the same source field preserve the draft and block automatic recovery.
4. A definitive stale save may retry once after proven source recovery. Unknown
   outcomes retain the identical frozen request. Repeated conflicts stop rather
   than loop. Navigation and out-of-order reads cannot advance the wrong fence.
5. Source acknowledgements update the baseline used for compact saves and local
   draft backups. Existing lease, executed-prefix, idempotency and server fence
   regressions remain enforced.
6. Save failures, remote-update warnings, source notices and their dismissal
   update only the notice/status regions. Existing stop nodes, panel bounds,
   scroll position, focus and drag state survive. Notice wrappers consume no
   planner layout space, including at narrow widths.

Failure model: lost source acknowledgements (real HTTP regression); stale or
hostile recovery claims (archive/digest and property tests); draft overwrites
(three-way field tests); save/source races (deferred transport and repeated
saves); UI replacement/layout shift (real Chromium DOM and bounding boxes).
Tests use the disposable runner, mbbs-tests.slice and bounded containers. All
test resources and generated output are removed; only concise evidence and
operational audit records remain.

Addendum: a draft journal saved by the old browser may already have the source
conflict when the user refreshes to receive this fix. Restore Draft must accept
that draft only after the same source-only proof and three-way conflict check;
ambiguous pending requests keep their original retry identity. Navigation during
the recovery read must leave the newly selected date untouched.
