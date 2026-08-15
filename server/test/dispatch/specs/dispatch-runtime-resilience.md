# Dispatch plan runtime resilience — executable specification

Tier: 3 (edit-lease concurrency and saved-plan data integrity)

Spec approval: not obtained (autonomous incident response). The user supplied the concrete Aug-14 failure, the console trace, and the Cheng lane example; this file records the acceptance boundary after the fact.

## Failure model

- A saved stop may reference an order that is temporarily absent from the global open-order feed; dereferencing that missing catalog row can crash the whole plan.
- The large cross-date feed may contend with compact bootstrap, delaying the usable plan by tens of seconds.
- A later feed may erase an assigned snapshot order, making a successful initial render fail nondeterministically afterward.
- Reloading the page may release a valid edit lease and force the same dispatcher into View Mode.
- Reusing a stored lease on another plan date or browser-tab session could grant editing in the wrong scope.
- Treating a transient network/server failure as an authoritative rejection could silently discard recoverable edit ownership; treating a 4xx rejection as transient could retain invalid ownership.
- A service worker may try to cache `chrome-extension:` requests and reject its fetch promise.
- A stale saved driver-lane key with no load content may render as a duplicate historical driver; pruning too broadly could remove a real historical load.

## Acceptance scenarios

1. **Missing compact order is render-safe**
   - Given a compact-plan stop whose catalog order is `null`,
   - when drop-off resolution runs,
   - then it returns no catalog drop-off and does not throw.

2. **Real Aug-14 assigned custom order survives feed refresh**
   - Given plan `234` on `2026-08-14` assigns custom order `3022118075`,
   - when the global feed returns no row for that order,
   - then the assigned order remains in the planner catalog.

3. **Compact plan becomes authoritative before the expensive feed**
   - Given Dispatch startup,
   - when initialization begins,
   - then compact plan bootstrap completes before the global order feed starts.

4. **Same-tab reload resumes a validated edit lease**
   - Given an acquired lease stored in `sessionStorage`,
   - when the same tab reloads the same plan,
   - then it validates the token by heartbeat, returns to Edit Mode, and does not release the lease during reload.
   - When the user explicitly selects Exit Edit,
   - then the server lease is released and the stored credential is removed.

5. **Lease credentials fail closed outside their scope**
   - For at least 256 deterministic plan/session/token combinations,
   - a credential round-trips only for its exact plan date and tab session.
   - Malformed or incomplete stored values return `null`.
   - HTTP 4xx heartbeat failures end local edit ownership; network and HTTP 5xx failures retain credentials for retry but do not claim validation succeeded.

6. **Unsupported service-worker schemes are ignored**
   - Given a `chrome-extension:` GET request,
   - when the Operator service worker receives the fetch event,
   - then it does not call `respondWith` and does not enter the Cache pipeline.

7. **Only empty stale historical lanes are pruned**
   - Given one active Cheng Driver Setup record and an obsolete saved lane key with zero planning content,
   - when lane order is reconciled,
   - then the empty obsolete key is removed.
   - A disabled/historical driver that still owns a saved load remains visible with its saved name and load.

## Must-not-change invariants

- Do not delete or disable the active Cheng Driver Setup record.
- Do not remove a historical lane that contains any saved stop, order, or return load.
- Do not let the global feed replace compact saved-plan evidence for currently assigned orders.
- Do not persist edit tokens in cross-tab `localStorage`; credentials remain tab-scoped in `sessionStorage`.
- Do not add dependencies or broaden network, filesystem, subprocess, or environment capabilities in production code.
- Do not change production containers or data until a separate deployment is authorized.

## Setup and verification plan

- Use the existing pinned Node, PostgreSQL, Chromium, and WebKit images in `docker-compose.mbt-test.yml`; add no package.
- Add focused Node regressions, a deterministic property test, a two-engine Playwright test, and a persisted five-mutant runner.
- Run syntax, type, lint, focused tests, the full Node suite, browser execution, mutation, license/dependency-tree, secret, and repeat-order checks in the disposable `mbbs-mbt-p1-test` project.
- Tear down that exact test project and remove only its exact test images after the run.
- Identify the tested dirty source tree with the persisted source-state command; do not create checkpoint commits because the accepted shared worktree contains unrelated tested changes.
