# Control local-only reopen

User direction (2026-10-21): reopen must ensure the local order is open and must
not check NetSuite. This replaces the earlier rejection contract for cached
NetSuite status, fulfillment quantities/IDs, and historical posted steps.
Spec approval: not obtained (autonomous run). Tier 3: local progress reset,
immutable history, and concurrent local operations.

1. Search, preview, and confirmation use local data without fetching a NetSuite
   location directory, verifying an IF, or making any NetSuite request.
2. Historical IF references, fulfilled quantities, Pending Billing/Billed status,
   and released posting claims do not hide Confirm reopen or reject confirmation.
   The local Operator header, packing/loading/fulfillment progress and preparing
   ownership reset. Synced order status and original history/photos are retained.
3. An audited SO reopen supersedes exactly the fulfillment records present in
   its preview. A previously fulfilled F/G order is available in Operator and
   Dispatch. New fulfillment evidence or new local loading ends that exception;
   a bare Open header or an unrelated order cannot acquire it.
4. Cached closed/inactive NetSuite headers do not block the Control reset. This
   changes the local reset command, not separate normal closed-order sync rules.
5. Local receipt evidence, active posting/reload/consolidation, started Driver
   work, role/yard authorization, stale previews, atomic groups and idempotent
   retries retain their existing protections. New historical evidence between
   preview and confirmation also makes the preview stale.
6. The page explicitly labels Confirm reopen, requires a reason and confirmation,
   explains local progress reset, and retains photos and audit history.

Failure model: a reset that remains hidden by old IF evidence (real API/browser
and Dispatch tests); erased history (database conservation); new fulfillment
mistaken for old (identity-specific ledger tests); unauthorized/partial/racing
reset (existing auth, rollback, PostgreSQL race and retry suites); accidental
remote access (enabled-config offline boundary test); repeated reset altering
new work (retry and property tests).

Setup: existing Node, PostgreSQL, Playwright, TypeScript, ESLint, c8, fast-check;
no dependencies, migration, or commits. Use a current live-source snapshot with
only the task overlay, the standard bounded isolated Compose configuration and
the retention wrapper's unique MBBS_TEST_ARTIFACT_DIR. Register teardown before
startup; remove all test output and resources, verify both Docker listings and
production health. Keep only this specification, concise evidence, reproducible
source scripts and operational deployment audit/rollback records. The full
relevant reopen/Operator/Dispatch suites are the regression boundary.
