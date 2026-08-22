# Driver plan-date execution boundary

## Incident

On 2026-08-17 in `America/Toronto`, Nick had no assignment for the current
day. The Driver PWA correctly found his next confirmed assignment, but that
assignment was plan 238 for 2026-08-18. The online Start route accepted
SOB118183 at 19:06 Toronto time because start mutations had no plan-date
boundary.

## Invariants

- A confirmed future route can remain visible for preview and offline-shell
  preparation.
- A Driver job whose plan date is later than the current calendar date in
  `America/Toronto` cannot start.
- Online, ordinary offline-sync, and MBT BIN starts use the same policy and
  stable `DRIVER_PLAN_NOT_STARTED` error.
- The online route checks both the initially selected job and the live job
  immediately before mutation. The repository checks again as the final
  persistence boundary.
- The Driver PWA disables recording controls and refuses to queue Start while
  the route is future-dated.
- A route becomes executable at 00:00 in Toronto, including across UTC and DST
  boundaries.
- Current-date work, past-date recovery, and delayed offline replay remain
  allowed. This prevents the fix from weakening existing historical-route
  recovery.
- Missing, malformed, or impossible plan dates fail closed.

## SOB118183 repair

The production repair must use the existing audited Driver PWA reopen
workflow. It may reset only the validated Nick / plan 238 / 2026-08-18 /
SOB118183 in-progress record. The workflow preserves the confirmed plan and
route, records before/after evidence, clears only premature progress, refreshes
the load projection, supersedes the stale offline manifest, and leaves the job
pending for its plan date.
