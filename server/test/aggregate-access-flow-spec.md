# Separate Aggregate access and requester workflow

Tier 3: authorization, concurrent permission changes, and request state transitions. Spec approval: not obtained (autonomous run); this implements the user's explicit corrections and is available for review after the fact.

## Acceptance scenarios

1. Ordinary Operator/Sales/Manager yard grants alone grant no Aggregate submission access. Admin assigns Aggregate request access independently. Each yard has at most one designated submitter, who must be an active Operator, Sales, or Yard Manager. Accounts may hold multiple Aggregate yards. SCM/Admin management remains available, but does not automatically grant submission rights.
2. Admin can assign, remove, or reassign a yard from the Accounts page using a separate save action. Normal roles and yard access remain unchanged. A stale or concurrent assignment edit returns 409 without partial changes. Changes are audited atomically. No existing yard grants are automatically copied into Aggregate access.
3. Existing sessions receive current Aggregate rights on their next request. Forged bodies, unassigned roles, out-of-yard requests, revoked retries, and stale in-flight submission access cannot bypass the grant. Existing records and SCM review remain intact after reassignment; SCM can resolve former requesters' outstanding reports.
4. For an assigned yard with no outstanding/current request, the requester sees seven material cards plus the yard/submit card. After submission, the page immediately becomes “Edit submitted request”, prefilled with submitted loads. Reload preserves this stage. There is no new-request action, filter, history list, or comparison table while that request is outstanding.
5. SCM confirmation changes the requester page to “Report actual received / collected loads”, using the same eight cards. Cards show confirmed quantities and separate actual inputs. Actual submission retains the original next-day rule and explicit zero requirement. After reporting, the user can request the next service date. SCM's management filters/history remain available.
6. Live updates preserve unsaved values when the request stage is unchanged. SCM confirmation changes an edit form into the actual-report form. Revoked access removes submission controls. Background refreshes cannot restore stale views or overwrite a newer yard selection.
7. English/Chinese cover Admin Aggregate access and all requester stages, errors, dates, and quantities. Switching language preserves entered values. Operator Inventory keeps Damage/Count Sheet unavailable and uses the dedicated Aggregate grant for its active Aggregate entry.
8. Admin-only endpoints, validation, uniqueness, optimistic concurrency, revocation, atomic rollback, request-stage transitions, responsive rendering, and direct API bypasses have executable checks. Existing SCM approval, one yard/date request, load validation, reporting dates, audit history, and normal account access are regression constraints.

## Failure model and setup

- Accidental inherited or administrative submission access: role/grant matrix, property tests, authenticated HTTP and mutation tests.
- Two designated users or lost Admin edits: one database row per yard, row locks, revisions, concurrent update tests.
- Permission revocation racing a write: recheck the grant under a transaction lock, test the waiting writer and retries.
- Partial access/audit writes or migration damage: forced rollback tests, migration reapplication and rollback rehearsal in disposable schemas.
- UI showing the wrong stage, losing inputs, or exposing hidden controls: real Chromium flows including SCM confirmation and fresh-session/reload tests.
- Existing regressions: capture baseline before edits, then compare the full isolated suite with zero new failures. Unrelated failures remain documented.

Use existing Node, PostgreSQL, Playwright, ESLint, TypeScript, c8 and fast-check in the prepared Docker test image; add no dependencies or lockfile changes. Preserve this dirty worktree, create no commits, and retain pre-change snapshots and source hashes. Add a migration, small access policy/repository/router modules, scoped UI/auth wiring, tests, reproducible validation and deployment tools. Deploy only the verified task diff over the live image under the continuing deployment authorization. Do not change other services or operational requests during verification.

## Added regression discovered during suite health

9. Switching the selected SCM request removes the previous request's actions while the newly selected details load. A delayed-detail browser test must verify that the old Confirm button is unavailable and only the chosen request is confirmed/reported. Repeated browser execution exposed this existing timing issue; the release includes the one-line clearing fix and a new SCM client asset version.
