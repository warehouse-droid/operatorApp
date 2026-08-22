# Dispatch Planner Indexed Pool and Durable Command Specification

Approved source: the user-approved “Dispatch Planning Performance and
Historical Replay Plan”, including the later requirement that validation-
blocked saves remain recoverable.

## Failure model

- A stale or repeated browser command must not apply twice or overwrite a newer
  revision.
- A plan mutation must not leave snapshot, assignment, relationship, or
  delivery-group projections at different revisions.
- A global search must not hide an order merely because it belongs to another
  date; it must return that order read-only with its owning route.
- Default pool reads must not return already-planned orders.
- Split parents, group children, and direct-link relationships must not become
  independently assignable through a stale projection.
- Autosave volume must not create a full history document for every gesture or
  duplicate the full board in every command receipt.
- Save Now and lifecycle boundaries must produce a durable checkpoint even
  when there is no unsaved browser edit.
- A rule-blocked candidate must be retained as an unresolved `save_recovery`
  document while the active plan and operational projections remain unchanged.
- Restore must not roll back NetSuite/SCM source state or Driver execution
  evidence.
- Catalog lag, malformed cursors, hostile replay payloads, and worker retries
  must fail closed and remain bounded.
- No Driver PWA asset, endpoint, IndexedDB schema, cache version, job identity,
  photo reference, or completion evidence may change.

## Executable scenarios

1. Runtime modes accept only `off`, `shadow`, and `on`, defaulting invalid
   values to `off`.
2. Compact order cards retain planning/search identity but exclude raw payloads
   and bounded item detail keeps one pool page below its budget.
3. A keyed plan delta round-trips every supported board shape, preserves order,
   and applying the same delta twice is idempotent.
4. Checkpoint policy becomes due at 25 commands or five minutes, distinguishes
   periodic/manual/lifecycle/recovery retention, and never expires unresolved
   recovery drafts.
5. Historical replay orders events by server time, then source sequence, uses
   Driver device time only as secondary causality, and labels transitions
   `exact`, `state-derived`, or `gap` without silently dropping gaps.
6. The indexed order-pool endpoint defaults to unplanned eligible rows; search
   includes planned rows as read-only and returns route/Jump metadata with a
   stable cursor.
7. Assignment projection expands grouped children and split-parent aliases and
   is rebuilt in the same transaction as the active plan.
8. Typed commands store compact receipts, produce no per-command full
   checkpoint, reject stale revisions/digests, and exact retries cause no second
   side effect.
9. Save Now creates or deduplicates an exact-revision manual checkpoint even
   for a clean plan. Periodic and lifecycle checkpoints obey their independent
   retention windows.
10. A validation-blocked typed or compatibility save creates/deduplicates a
    `save_recovery` snapshot and changes no active snapshot, assignment,
    relationship, SCM, delivery, or Driver row.
11. Restore validates current canonical state and the executed Driver prefix
    before changing planner-owned state.
12. Search cancellation aborts superseded HTTP work; plan autosave does not
    wait for route estimation; compact bootstrap remains the only startup
    critical path.
13. Shadow mode records parity differences without serving the optimized
    result; `off` instantly returns to legacy behavior without a Driver PWA
    release.
14. The 14-day causal replay compares the legacy and optimized projections
    after every causally ordered Dispatch, SCM, NetSuite-derived, and Driver
    event and emits exact/derived/gap coverage.

## Setup and constraints

- Use the existing Node test runner, PostgreSQL test container, `c8`, ESLint,
  and manual mutation framework; add no package dependency.
- Add only additive migrations. Do not deploy, migrate production, or modify
  the running production containers.
- Preserve the existing dirty worktree and make no checkpoint commit.
- The final gauntlet must run in the disposable `mbt_test` environment and
  include the existing 163 Dispatch tests plus new tests, lint, coverage,
  mutation, replay, and Driver-isolation contracts.
