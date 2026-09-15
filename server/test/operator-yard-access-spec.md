# Operator yard access and PWA layout

Approved by the user's “Implement the plan” on 2026-09-15, following the proposed plan and explicit choices: separate grants, start empty, no access without assignment, and choose on each login when multiple yards are assigned.

## Acceptance scenarios

1. **Independent grants:** New and migrated non-admin accounts have `operatorYardLocationIds: []`. Assigning Operator yards never changes Sales/Control `yardLocationIds`. Creating or updating accepts only the four existing yard IDs (1, 28, 15, 26), rejects malformed IDs, and records grants in the audit. Omitted updates preserve grants. Login and existing sessions expose current grants.
2. **Entry:** Zero grants shows the no-access message with logout; one grant opens the menu at that yard; multiple grants show only those yards. Admin retains all four. Yard 195 is outside this change.
3. **Session isolation:** Selection survives reload within the same login. A new login, another account, or logout discards local operational state. Switching is limited to authorized yards and preserves existing active-work restrictions. Revocation clears inaccessible views and blocks subsequent requests. Delayed responses from an old account/yard cannot restore inaccessible data.
4. **API authorization:** Lists require authorized yard filters. Orders, lines, drafts, consolidation batches, history, job status and related media resolve yard rights from stored data before reads/writes. Forged location parameters cannot authorize another yard's records. Receiving uses destination; delivery/pickup uses outbound/source; returns use receiving yard; inventory/cycle count use stored location. Existing ownership checks remain.
5. **Shared consumers:** Existing Control endpoint grants stay independent; shared inventory synchronization respects server-verified Control or Operator permissions. Saved records and accepted background jobs remain intact after revocation.
6. **Pallet balance:** A balance with 100 purchased, 30 returned and 10 reserved shows only “Available to return: 60”. Historical totals are absent in every shared editor. Lookup status, photos, current quantity and over-limit validation remain.
7. **Delivery lists:** Active/Packed fill one equal-width row matching Batch/Saved Orders sizing. The page order count is removed. Pagination, individual batch counts, filters and consolidation actions work in English and Chinese.
8. **Rollout:** Additive migration, no copied grants, no deleted work; refresh Operator PWA HTML and service-worker asset versions. Admin must assign non-admin yards before use.

## Failure model and validation

- Cross-yard disclosure or mutation: real authenticated API tests, hostile record IDs/filters, property tests for authorization sets, targeted mutants.
- Stale login/yard state or in-flight replies: real browser login/reload/logout/switch/revocation checks including delayed responses.
- Privilege coupling: independent grant round trips, omitted updates, admin and Control regression checks.
- Invalid permission input or partial migration: malformed input properties, repeatable migration on isolated PostgreSQL, existing-account default checks.
- Hidden quota enforcement or broken layout: real browser return validation and measured button geometry with both translations.
- Silent regressions: full existing suite with baseline failures recorded; static checks, changed-line coverage, mutation and randomized ordering; evidence never treats unexecuted layers as passing.

## Setup

Tier 3 old-coder workflow. Use existing Docker Node, PostgreSQL and Chromium images, existing fast-check, coverage, lint and type tooling. No new dependencies or commits. Preserve the dirty workspace; task baseline snapshots live in ignored test-artifacts. Add focused tests, fixtures, a reproducible runner and evidence. Deployment uses the approved additive migration/application rollout; retain rollback image and a database backup. No automatic non-admin yard assignments.

## Record-scope clarification from implementation review

Grouped Delivery records aggregate several stored orders. Scenario 4 applies to every child yard, including saved lists, consolidation and load views. A group with an unassigned child yard is withheld; authorized standalone orders remain visible. Accounts assigned all child yards retain grouped access, and the stored group and saved rows are preserved. The review also adds a delayed authentication-check scenario: a newer access-change event must queue a fresh read after an older check completes.
