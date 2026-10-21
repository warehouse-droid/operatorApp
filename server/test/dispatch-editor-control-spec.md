# Dispatch date-plan editor controls — 15 October 2026

Spec approval: not obtained (autonomous run). Tier 3: authorization and concurrent plan writes.

Acceptance scenarios (append-only):

1. Admin dashboard lists active editors with plan date, user, and expiry. No lease token/hash appears. Anonymous users receive 401 and dispatchers receive 403 on both Admin endpoints.
2. Admin can kick the displayed editor. Removal and a durable audit entry commit together. Other dates and saved plans are unchanged. The old token cannot heartbeat or save. A different dispatcher can immediately acquire the date.
3. A stale Admin action cannot remove a replacement session, including reacquisition by the same browser. It returns 409. No active lease is an idempotent no-op.
4. Kick and pending plan saves serialize through the existing date lock: a save waiting behind a kick must fail; a committed save remains saved.
5. Heartbeats carry elapsed time since actual user activity. They keep an active user editing but do not extend a motionless user's expiry. At exactly 600000 ms inactivity the client leaves Edit Mode and the server refuses renewal. Missing activity data from old pages cannot extend the lease.
6. Only trusted pointer, keyboard, input, touch and scroll events count as activity. Timers, network responses, SSE updates, synthetic events and visibility changes do not. Reload resumes the server-validated lease and preserves its inactivity age. Expired credentials cannot be revived by activity or a delayed heartbeat response.
7. Dispatch and snapshot restore both use the inactivity behavior. Removing editing preserves local draft recovery; no forced save or discard occurs during kick/timeout.

Failure model: bypassed Admin authorization (real HTTP role tests); stale selection/ABA replacement (session plus acquired timestamp fence); kick/save races (database barriers); audit loss (transaction rollback); idle heartbeat renewal and delayed response revival (fake clock and real database tests); malformed input (adversarial API cases); unintended release scope (image overlay/hash comparison and rollback).

Setup: use existing Node test runner, Playwright, TypeScript, ESLint, c8 and fast-check from the existing toolchain. Add scoped tests, scripts, source baselines and evidence under existing test/tool/artifact folders. No dependencies, schema changes, git commits, or external messages. Use bounded disposable Compose, register teardown before starting, remove containers/volumes/networks and verify production health. Prepare an app-only image overlay on the live image, preserve unrelated changes, validate the candidate and retain a rollback image. Record unavailable or out-of-scope gauntlet layers honestly.

User amendment: Dispatch also has a Kick out button for the displayed date's other editor. Both Admin and Dispatch require a popup confirmation naming the user and date. Cancel sends no kick request. The Dispatch endpoint permits dispatcher/admin roles and rejects other roles. The same stale-selection and audit guarantees apply to both entry points.

Activity refinement from code inspection: layout restoration can generate trusted `scroll` events without user input. Observe wheel/touch movement instead of raw scroll so restoring page position cannot renew an idle editor.
