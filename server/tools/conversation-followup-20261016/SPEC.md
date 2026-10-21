# Conversation follow-up executable specification

Spec approval: not obtained (autonomous run). Tier 3 because the fix touches authorization.

1. SCM and SCM staff with no Sales yards can read, send and acknowledge Special and Backorder conversations at any supported yard. Sales remains restricted to assigned yards; existing authentication, feature flags and closed/read-only checks survive.
2. Empty conversation history never displays “Loading conversation”; after an empty response it displays “No messages yet” and permits the first message. Errors remain visible and retryable.
3. A newly posted message moves its request ahead of older/no-message requests on Sales and SCM, for Special, Backorder, Stocking Transfer/Purchase and Delivery. Ordering is applied before pagination and after refresh, including Sales status-filter queries. Duplicate retries cannot make an older conversation appear newer.
4. Live updates reorder the filtered queue without replacing the selected detail, losing text/focus, or changing workflow revisions. Requests outside a loaded page are fetched using the same filters; an update never bypasses yard or search filters. Business/audit events do not change conversation priority.
5. Existing typed-only history, private-event exclusion, unread notifications, idempotent sending and legacy reply transitions continue to work.

Failure model: accidental cross-yard Sales access -> real HTTP positive/negative auth tests; missing unseen/page-limited requests -> pagination/filter integration and browser tests; stale event/retry reorder -> monotonic ordering property tests; lost edits -> full-page browser draft/focus checks; closed/send races and duplicate writes -> existing transaction/concurrent tests; production contamination -> isolated bounded standard Compose tests with teardown registered before launch and health/ps/ps-a checks.

Setup: reuse installed toolchain (Node test, Playwright, fast-check, c8, TypeScript, ESLint). No runtime dependencies or migrations. Back up only scoped files; no commits or resets. Preserve unrelated workspace changes by patching captured live source, test the exact candidate, deploy app-only with rollback, and run read-only health/static probes. Never write a live message or close a live request as a test.

Gauntlet: reproduce failures first, run conversation and related workflow suites, syntax/lint/types, changed-line coverage, 3-5 manual mutations and ordering properties, reverse-order unit suite, secret diff scan, exact-candidate release checks. Existing unrelated special-information stage mismatch is recorded separately; zero new failures required.

Fixture correction before implementation: scm_staff is an obsolete guard alias, not a valid persisted operator role in the schema or account API. SCM staff use scm; test valid scm and admin accounts with no yards. The first RED attempt was an invalid-role setup failure, not bug evidence.
