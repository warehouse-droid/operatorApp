# Removed active travel recovery — 2026-09-11

Urgent follow-up to the authorized pickup/travel hotfix. Spec approval was not
separately obtained (autonomous run). No new dependency or migration is needed.

1. If Dispatch edits a pickup and its active/completed travel leg disappears or
   changes identity, recorded travel remains visible and resettable using the
   existing audited reopen endpoint, provided its load is still assigned to the
   same driver/truck on the same confirmed plan/date and later work has not begun.
2. Reset retires the obsolete execution state to pending; it does not insert
   the old travel destination into the new plan or mark it completed. After an
   active orphan is reset, the PWA selects the new route without the orphan error.
3. An explicit target stop anchors within-load travel recovery. Without that
   target, recovery considers the entire load for later activity and fails closed.
4. State hash, newest-first, rest, foreground action, offline-event checks,
   manifests, original evidence, audit, and exact retry remain enforced.
5. Missing physical pickup/drop records remain blocked. Removed-load, driver,
   truck, plan/date and later-progress conflicts cannot use this travel exception.
6. Dispatch explains that Reset resumes the current route and does not recreate
   the removed leg. Existing assigned-stop Restart/Reopen behavior stays intact.

Failure model: hidden active work; misleading old destination; bypassing physical
evidence or later-progress guards; stale/concurrent reset; lost audit; old offline
events replayed; UI/server eligibility disagreement. Cover with real database
rollback tests, policy cases, existing concurrency/offline regressions and UI
render checks. Build from the current exact production image and compare release
files. Use focused checks for the ongoing production hotfix; defer full-project
coverage/type/lint/browser/mutation gauntlets as in the preceding hotfix.

## User-directed revision: automatic closure

The user explicitly replaced the manual-reset approach: when travel is no longer
in the plan, close it automatically and present the new travel for a fresh start.
This supersedes acceptance criteria 1–6 above and the unimplemented reset UI.

A. PWA day-state, next-job and day-plan refresh automatically close only missing
   in-progress travel as `superseded`, preserving timestamps/details and an audit.
B. The current plan is re-read under the shared fleet/driver-day transaction
   locks before closure; concurrent refreshes create one closure/audit.
C. Replacement travel remains pending and needs a new explicit driver start.
   No replacement travel means the next current pickup is presented normally.
D. Existing current travel, completed history and missing physical work remain
   untouched. Physical route conflicts still block work.
E. Obsolete offline manifests/events for the removed travel are retained and
   superseded as evidence; load execution projection is refreshed. No physical
   completion, billing, delivery notification or old route reconstruction occurs.
F. Automatically apply this repair to the affected active travel during normal
   PWA refresh after deploying the hotfix; no separate Dispatch reopen is needed.
G. If an identical travel leg is subsequently added back, it is pending and an
   explicit start records a new start time. The prior closure remains auditable.
