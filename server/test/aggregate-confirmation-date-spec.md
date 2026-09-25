# SCM confirmation date — 2026-09-25

Scope: add date selection to Aggregate confirmation, then deploy it together with the previously tested top-bar alerts and submission timestamps. Existing deployment authorization remains in effect.

Old-coder Tier 2, with API compatibility and concurrent-save checks for the existing authenticated command. Spec approval: not obtained (autonomous run). The acceptance criteria were stated to the user before implementation; there was no separate human spec review.

Acceptance criteria:

1. SCM opens Confirm loads or Revise confirmation. A required Delivery / collection date input starts with the saved date. Changing it previews an actual-report due date one calendar day later. Language changes and live refreshes preserve the unsaved selection.
2. Confirming `2028-02-29` atomically saves that date, `2028-03-01` as the due date, and all confirmed quantities. Both SCM and the requester see the same saved date after reload. The original submission timestamp and requested quantities remain unchanged.
3. Confirming without a `serviceDate` property preserves the existing dates for compatibility with already open clients. Choosing the same date is valid. SCM may select a past date when recording a late confirmation; there is no new future-only restriction.
4. Only a real `YYYY-MM-DD` calendar date from `0001-01-01` through `9999-12-30` is accepted, leaving room for the following due day. Empty, null, numbers, arrays, timestamps, nonexistent days, year zero and out-of-range years fail with HTTP 400 and leave dates, quantities, revision and history unchanged.
5. Dates are calendar dates independent of server/client timezone and daylight saving. Month end, leap years, year end and DST all retain a due date exactly one day after service.
6. Existing SCM permissions, owner restrictions, expected revisions, idempotent retries, transaction rollback and one-unfinished-request-per-yard remain enforced. Non-confirm commands cannot change dates. Completed/rejected requests cannot be reconfirmed. Racing confirmations produce one complete winning schedule, never mixed date/quantity values.
7. History records and displays both old and new Delivery / collection dates for confirmations that change the date. An unchanged date creates no misleading date-change line.
8. Existing Aggregate request flows, global alerts, exact submission timestamps and neighboring stock request/navigation behavior keep passing. Deploy only the combined feature patch over the captured current application image; retain unrelated live changes and configuration, verify the exact candidate before cutover and retain a rollback image.

Failure model: invalid dates or UTC offsets shift operations (strict validation + date properties); only one of the linked dates saves (real PostgreSQL constraint + reload checks); concurrent/stale or retried saves overwrite another confirmation (race and idempotency tests); an unauthorized or non-confirm command changes dates (HTTP/domain boundaries); a form refresh loses the selected date (browser workflow); audit or deployment failure leaves a partial change (transaction rollback, source/image hashes and rollback path).

Setup: reuse the existing Node test runner, fast-check, c8, ESLint, TypeScript, Playwright and isolated Aggregate Docker database/runner. No dependencies, migrations or Git commits are added. Persist focused tests, mutation/check scripts, a combined deployment tool and evidence. Preserve the pre-change workspace snapshots because this checkout already contains unrelated changes. Run the project suite against baseline and candidate where needed to identify existing failures; do not weaken unrelated tests.
