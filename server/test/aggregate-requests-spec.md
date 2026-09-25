# Aggregate Requests acceptance specification

Approved in the conversation on 2026-09-22; implementation authorized by “Implement the plan.”

## Behaviors

1. A standalone staff module permits Sales, Operator, and Yard Manager submissions for assigned yards; Admin has all four yards. SCM manages requests across yards. Public Sales, Dispatch-only, and unassigned staff cannot access request data.
2. Seven local materials use integer loads: Gravel, HPB, Screening, Crusher Run inbound; Dump Concrete, Dump Asphalt, Dump Soil outbound. At least one requested quantity is positive; all actual quantities require explicit entries, including zero.
3. Toronto calendar dates govern the workflow: Monday submission → Tuesday service → Wednesday report. Weekends, holidays, and DST do not change this sequence. A form with yesterday's proposed service date is rejected, not silently retargeted.
4. Exactly one durable request exists per yard/service date. Simultaneous submissions and retries cannot duplicate it. Only its creator edits requested quantities before SCM confirmation.
5. SCM confirms/revises quantities until reporting, preserving requested quantities. SCM may reject an unconfirmed request with a reason.
6. Once its report date arrives, either an unconfirmed request or a confirmed request without actuals blocks that creator's next submission at that yard. Other users/yards are unaffected. The API enforces this atomically.
7. The creator, SCM, or Admin can report actuals on/after the report date. Reporting clears the submission block even when SCM review is pending. No demand is automatically carried forward.
8. Confirmed 3 / actual 2 means a shortfall of 1 and Needs Review until explicit SCM acknowledgment. Excesses and zero actuals also reflect reality. SCM/Admin correction requires a reason and invalidates previous acknowledgment when a difference remains.
9. Every write records actor, action, timestamp, before/after, and retry identity. Stale revisions and reused retry identities with different contents fail without partial writes.
10. Regular, Special, and Aggregate tabs retain their own data; late network responses and language/live updates cannot repaint an inactive tab or discard a form in progress.

## Failure model and validation

Tier 3: yard/role leakage (domain + HTTP adversarial checks); duplicate daily demand and lost updates (real PostgreSQL concurrent commands); partial writes (transaction/audit rollback); wrong-day blocking (clock-boundary/property tests); silently lost discrepancies (review persistence tests); inaccessible screens (browser + accessibility checks); existing-workflow regressions (baseline and final existing suites).

## Setup

Reuse installed Node test runner, PostgreSQL, Playwright/axe, fast-check, c8, ESLint, and TypeScript. No new dependencies. Use a dedicated internal Docker network/database and disposable runner; do not operate on the production database. Preserve all existing worktree edits; no commits or deployment are included. Add an additive migration, feature tests, repeatable validation scripts, and evidence. Baseline snapshot: /tmp/aggregate-requests-baseline/server.

## Invariants

No NetSuite item references, inventory mutations, external messages, or automatic carry-forward. Existing auth/home routes and Regular/Special request APIs retain their behavior. Empty yard assignments never grant all-yard access. Rejection terminates that yard's daily request; a second request for the same yard/date is not created.
