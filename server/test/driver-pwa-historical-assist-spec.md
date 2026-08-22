# Dispatch historical Driver-PWA completion — executable specification

Status: approved for implementation on 2026-08-20. Deployment is explicitly out of scope.

## Goal

Add a third **Historical completion** tab to Dispatch → Driver PWA tools. An authenticated dispatcher or administrator can select a past Toronto plan date, review incomplete physical visits in the current confirmed plan, upload the same evidence required from the Driver PWA, and complete the next eligible physical visit on behalf of the assigned driver.

The feature must use the normal Driver operational completion effects and canonical billing admission. It must not change the Driver PWA application, service worker, cache version, IndexedDB schema, or route ownership.

## Access and scope

1. Only `dispatcher` and `admin` sessions may call the APIs or use the UI.
2. The selected date must be strictly earlier than today in `America/Toronto`; the UI defaults to yesterday and cannot select today or a future date.
3. Data comes only from the current confirmed plan for the selected plan date.
4. Closed, cancelled, removed, stale-plan, unconfirmed-plan, MBT BIN, travel, rest, DVIR, truck-switch, and return-only jobs are not completable here.
5. Incomplete pickup and drop-off physical visits are grouped by driver, load, truck, stop, and order references. A consolidated physical visit remains one action.
6. Every incomplete physical visit is visible, but only the earliest incomplete physical visit in each driver's physical route is actionable. Later visits show the blocking earlier visit.
7. Travel, rest, DVIR, and truck-switch state may be shown as a warning; those records do not determine physical-visit ordering and are never created or completed by this feature.

## Time rules

1. A visit already in progress preserves its stored `started_at`; the dispatcher enters only completion time.
2. A never-started visit requires both arrival and completion time.
3. Entered times must resolve to instants in `America/Toronto` on the selected plan date.
4. A nonexistent spring-forward local time is rejected.
5. An ambiguous fall-back local time requires an explicit EDT/EST choice, represented by a valid numeric UTC offset.
6. Completion must be at least 10 seconds after arrival/start.
7. Arrival/start cannot precede the preceding completed physical visit's `completed_at`.
8. Completion cannot exceed the following completed physical visit's `started_at`, falling back to its `completed_at` when no start exists.
9. A stored start outside the selected plan date is a blocking data conflict.

## Evidence rules

1. Photo requirement equals the Driver PWA rule: zero when the relevant requirement is disabled; otherwise `max(2, configuredRequiredPhotos)`.
2. The UI accepts camera or gallery JPEG/image input, compresses and hashes it with the existing Driver photo utilities, previews/removes selections, limits a visit to 20 photos, uploads at concurrency two, and retains selected in-memory evidence after transient failures.
3. The server issues presigned upload tickets only for the selected actionable visit and validates ordinal, byte size, SHA-256, JPEG MIME type, actor, plan identity, assist request identity, and expected R2 key namespace.
4. Completion verifies every uploaded object by read-back before entering the database transaction.
5. A zero-photo completion does not request upload tickets.

## Operational semantics

1. For a never-started visit, execute the same dependency checks and start projections used by Driver start, excluding GPS/Samsara and excluding automatic travel/rest/DVIR/truck-switch work.
2. Complete every underlying job in the selected physical visit with the normal Driver effects: closed-order guard, dependency completion, direct-pickup and transfer effects, custom-order effects, canonical dispatch completion/billing admission, and strict plan cleanup.
3. Do not automatically start the next job, start a rest, switch trucks, or alter Samsara state.
4. The assigned driver login remains the route owner. Job details, canonical completion, immutable assist ledger, and dispatch audit identify the authenticated dispatcher/operator, reason, request ID, and source `dispatch_historical_assist`.
5. The immutable assist event links the actor, driver, plan date/revision, physical visit, underlying job IDs, timestamps, photo references, request ID, reason, and outcome.
6. Exact replay of a successful assist request is idempotent and returns the stored result. A competing completion by Driver, offline replay, or another dispatcher returns conflict and never overwrites completed evidence.

## Safety and concurrency

1. Block completion while the same driver/date has nonterminal offline server events, unresolved client reports containing pending events/photos, or another foreground completion/start operation.
2. Direct users with sync evidence to the existing Sync Review tab.
3. Acquire the existing fleet planning lock, a driver/date advisory lock, and deterministic row locks for all underlying physical-visit records. Revalidate confirmed-plan identity, route eligibility, ordering, chronology, closed-order state, and upload evidence after locking.
4. All database projections and the assist ledger commit in one transaction. Any downstream database failure rolls the transaction back. Successfully uploaded R2 objects may remain orphaned for lifecycle cleanup.
5. Existing completed photo evidence and completion metadata are immutable under all races. Reopened pending records may accept new evidence on their next legitimate completion.

## API contract

- `GET /api/dispatch/driver-pwa/historical-assist?planDate=YYYY-MM-DD`
- `POST /api/dispatch/driver-pwa/historical-assist/:jobId/photo-tickets`
- `POST /api/dispatch/driver-pwa/historical-assist/:jobId/complete`

All endpoints require Dispatch login with `dispatcher` or `admin`, return `Cache-Control: no-store`, and use stable 4xx error codes for validation/conflict/recovery cases.

## Durable storage

Migration `174_driver_pwa_historical_assist.sql` creates an append-only `driver_job_assist_events` ledger with uniqueness for successful request IDs and triggers that reject update/delete. It also updates canonical dispatch completion projection so trusted assisted records use actor type `operator`, while ordinary Driver completions remain actor type `driver`. No historical backfill is performed.

## UI and accessibility

1. The existing Dispatch Driver-PWA tools page gains a third tab without altering the Driver PWA bundle.
2. The screen has a labelled past-date input, refresh action, grouped visit cards, explicit actionable/blocked state, chronology context, photo count, reason, time fields, upload progress, retry guidance, and a confirmation step.
3. Keyboard navigation, visible focus, status announcements, error summaries, button labels, and photo alt text are required. The interface must remain usable on mobile-width Dispatch screens.

## Failure model and required evidence

The gauntlet must exercise: invalid and DST timestamps; plan rollover/stale revision; closed/removed orders; consolidated visits; zero/high photo policies; forged/missing/corrupt/oversize uploads; duplicate request replay; two dispatchers; Driver versus dispatcher; offline replay versus dispatcher; transaction rollback; immutable ledger; canonical actor projection; dependency/start/completion failures; UI validation/retry/accessibility; and unchanged Driver offline behavior.

Required fresh evidence before handoff:

1. Unit and property tests for policy/time/order/photo invariants.
2. Migration, repository, HTTP-contract, adversarial upload, and transaction tests.
3. Deterministic concurrency tests for all competing writers.
4. Browser/UI contract and accessibility tests.
5. Mutation checks for critical ordering, time, photo, and immutability predicates.
6. Typecheck, lint/syntax, targeted coverage thresholds, full application regressions, and the existing 320-case Driver offline stress matrix.
7. One persisted gauntlet command with source-state capture, isolated Docker execution, teardown of test containers/images, and a final evidence report.
