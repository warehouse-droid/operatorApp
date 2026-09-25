# Operator delivery display refresh and linked-supply references

Spec approval: the user approved the proposed plan with “Implement the plan.”
Tier 3: asynchronous UI races and packing eligibility. No production writes,
deployment, new dependencies, migrations, or checkpoint commits are needed.

## Executable acceptance criteria

- R1: Delay an Active refresh, select Packed, then release Active. Packed keeps
  its packed orders; 38 Active orders never become 13 Packed pages.
- R2: Delay Packed, return to Active, then release Packed. Active keeps its
  current orders and selection.
- R3: Reverse completion of two refreshes in the same context. The newest
  request wins. A failed refresh retains the last successful list.
- R4: Invalidating data while a Packed prefetch is pending must prevent that
  response from repopulating a fresh cache. New events received during a refresh
  cause a subsequent refresh; event bursts are coalesced.
- R5: Responses from an old yard, session, module, preparation mode, load filter,
  tab visit, or detail selection cannot change the current screen. A local
  packing mutation invalidates earlier reads.
- R6: One Packed refresh requests SO, TO and VRMA exactly once, retains every
  supported type, and commits one coherent snapshot.
- R7: Valid same-view refreshes retain eligible order/line selection and page;
  page bounds are clamped after membership changes.
- L1: SOB120607-style non-converted material has original 2332 SQFT, manual
  pallet annotation 20, and PO allocation 2332 SQFT. It remains visible as
  reference-only with original and PO quantities and zero yard sales quantity.
  Grouping with the fully linked 20-EACH PALLET line preserves both references.
- L2: A pending planned group with only linked-supply references remains
  discoverable under Planned, never Packed solely because of reference lines.
  Completed/loaded groups retain existing exclusion rules.
- L3: Confirming a fully supplied line is rejected by the server, including a
  grouped line. Partial links retain their sales residual; cancelled links do
  not subtract; over-allocation stays blocked. Converted and physical-only
  manual lines retain their packing requirements.
- P1: Existing endpoint shapes, stored quantities, PO allocation records,
  fulfillment behavior, yard access and surrounding worktree edits survive.
- P2: The operator asset URL and service-worker cache change together so an
  installed PWA receives the fix.

## Failure model and verification

Wrong-screen writes and stale caches: deferred-request browser and unit races,
random completion-order properties, and request-guard mutants. Empty/partial
lists: failure injection, exact request-count and VRMA assertions. Incorrect
packing: projection properties and isolated PostgreSQL integration tests that
exercise grouped discovery and rejected confirmation. Layout: real Chromium
screenshots. Compatibility: current baseline versus final full suite, focused
linked-quantity tests, syntax, types, lint and secret checks.

## Setup and evidence

Use the existing Node test runner, fast-check, Playwright/Chromium, PostgreSQL,
c8, ESLint and TypeScript in existing Docker images. Baseline copies and all
test outputs live under test-artifacts/operator-display-fix. Persist tests,
fixtures, mutation checks and a single gauntlet entry point in the repository.
Record source hashes, the baseline failures, final results, changed-line
coverage and any explicitly unverified limits in the evidence report.
