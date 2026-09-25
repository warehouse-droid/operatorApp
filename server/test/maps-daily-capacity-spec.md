# Shared daily Google Maps capacity

Date: 2026-09-22 UTC. Scope: replace the embedded-map allowance and make usage and reopening understandable in Admin → Maps Usage.

The user selected **150 units per UTC day**, requested removal of the 300 embedded-map allowance, daily usage/limit display, feature attribution, and a reopen button. The overall 4,500-unit rolling 30-day ceiling remains in force. Detailed spec approval: not obtained (autonomous run); the policy choices above were explicitly confirmed by the user.

## Acceptance scenarios

1. With 149 units admitted today, any Google Maps feature can admit one unit; at 150, all features (including manual requests) receive `daily_limit` without contacting Google. Multi-unit requests cannot cross the boundary.
2. An embedded map at 300 or more map loads in the rolling window remains eligible when daily and overall capacity remain. Remove only its separate subsystem cap; retain the existing disabled/conserve modes and overall reserve rules.
3. Daily counts use UTC midnight and include every admitted unit, including failed calls. Denied attempts do not consume capacity. A new UTC day starts with 150 capacity, independent of yesterday's extra capacity.
4. Admin Maps Usage shows today's admitted/limit fraction, percentage, remaining units, reset time, blocked/failed counts, and the 30-day used/limit fraction with its actual period. Rank features by total admitted units and distinguish manual map loads from route refreshes.
5. When today's capacity is exhausted and overall capacity remains, an authenticated admin may reopen with up to 150 additional units for the current UTC day. Existing ledger entries and overall usage remain unchanged. The grant records the request ID, UTC day, actor hash, time, and added units.
6. Simultaneous reopen requests add at most one allowance. Repeating the same request ID never grants twice, including after further usage. A stale day, invalid request ID, missing actor, disabled Maps, or exhausted rolling ceiling cannot grant capacity. Unknown client-supplied amounts cannot increase the grant.
7. Reopening and admission share the existing transaction lock: concurrent requests cannot cross either daily capacity or the rolling hard limit. Reopening cannot lift disabled/conserve/overall reserve restrictions.
8. The reopen endpoint is admin-only; anonymous and non-admin callers fail. UI shows a pending state, prevents duplicate clicks, keeps failed requests retryable with the same ID, refreshes the counters on success, and explains that reopening lasts only for the UTC day.
9. All prior Google Maps fallback, route fingerprint, privacy, accounting, and request-coalescing behaviors continue. Dispatch can retry a previously denied map after capacity is reopened, using an explicit map refresh or a page reload.

## Failure model and verification

- Off-by-one or multi-unit overshoot: policy boundary/property tests and real PostgreSQL concurrency tests.
- Double-click/network retry or two admins: idempotency and concurrent reopen tests, same lock as admission.
- Midnight and timezone mismatch: UTC database boundary tests, stale-day rejection, expired-grant tests.
- Hidden history reset or global-budget bypass: before/after ledger checks and hard-limit tests.
- Privilege escalation/hostile input: authenticated HTTP checks and malformed request cases.
- Misleading UI: rendered output and browser checks using realistic usage, empty data, failures, and reopened states.
- Deployment regression: a scoped patch over the current runtime, source hashes, health and read-only postchecks.

## Setup and constraints

Use the installed Node, PostgreSQL, Playwright, ESLint, c8, and existing test dependencies in disposable Docker infrastructure. Add an additive migration, focused tests, reproducible test/mutation commands, and an evidence report. No new packages, commits, Google API test calls, production counter resets, or unrelated workspace edits. Tests must use an isolated database. Prepare and verify the complete change before deployment; no production reopen is needed to test the button.

Tier 3 is used because admission and reopening control paid requests and concurrent capacity. Report any skipped verification layer explicitly.

## Clarification during implementation

Reopen commands also carry the capacity the admin saw (`expectedLimit`). If another admin already changed that allowance, a delayed command must not reopen a subsequently exhausted allowance. A request ID which already granted capacity remains a no-op on retry. Concurrent commands against the same exhausted allowance may return a conflict; the UI invites a refresh.
