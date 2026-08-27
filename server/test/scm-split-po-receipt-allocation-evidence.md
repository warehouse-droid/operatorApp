# Split PO receipt allocation evidence

Date: 2026-08-27 UTC

## Diagnosis

- Production was queried read-only.
- `POB03535` target `3022019914` already calculated as ordered `1584`, received `1584`, remaining `0`, `Completed`.
- Its previous review reason was a family-level comparison of every Item Receipt location with only the parent PO destination.
- The two target allocations (`1569` material and `15` pallets) were both inferred from the source receipts; the split child itself had no duplicated local received quantity.
- A source-line/location capacity query found no overflow anywhere in `POB03535`. Every received quantity fits an active split child at that receiving yard or the parent residual at its yard.
- Therefore the review was a calculation-order defect: aggregate allocation occurred before destination validation, and the later parent-only validation rejected valid split-yard receipts.

## RED evidence

- Pure unit/property tests initially failed with `ERR_MODULE_NOT_FOUND` before `src/scm-split-receipt-allocation.js` existed.
- The rollback-only repository reproduction then failed with `actual 'review' !== expected 'ok'` for a parent at yard 3445 and fully received split child `3022019914` at yard 12441.
- An added adversarial test initially failed because location routing could silently ignore exact child evidence at a conflicting yard.

## Implemented behavior

- Linked PO receipt lines are grouped by exact source line and actual receiving location.
- Each location bucket can consume only child targets at the same destination (or source residual at the parent destination).
- Existing exact/pinned and chronological plan priority remains unchanged within one destination.
- Unknown-location quantity uses the existing aggregate allocator against remaining capacity.
- Wrong-yard quantity, capacity overflow, row-total mismatch, and unallocated exact evidence fail closed into reconciliation review.
- No memo/free-text matching and no changes to TO, driver, dispatch-plan, operator, or NetSuite evidence mutation paths.

## Verification completed

- Focused unit/property/integration suite: pass.
- Rollback-only `3022019914` reproduction: pass; `1584 / 1584`, remaining `0`, `Completed`, not blocked.
- Wrong-yard control reproduction: pass; remains `Reconcile Review`.
- Policy coverage: 100% statements, branches, functions, and lines.
- Focused ESLint: pass.
- TypeScript check: pass.
- Mutation testing: 8/8 mutants killed (100%), sources restored.
- Existing reconciliation repository/database harness: pass.

## Remaining genuine review witness

The same read-only capacity audit found one genuine unresolved quantity in `POB03658`: source line `4725023` (`UNI-BH60S-RDM-FOS`) has `3462.06` received at location 15 but only `2727.66` active split capacity there, leaving `734.40` unexplained. `IR14220` contains that exact `734.4` line, while the active `SN1398774` split ledger contains different `T` SKUs, not this `S` SKU. This case must remain review; the destination-aware fix must not auto-assign it to a different item or yard.

## Final gauntlet

`bash server/tools/scm-split-receipt-allocation-gauntlet.sh` passed from a fresh isolated PostgreSQL database after all 183 migrations:

- Focused split receipt suite: 14/14 passed.
- Reconciliation repository/database harness: passed.
- Core reconciliation harness: passed.
- Grouped PO reconciliation integration harness: passed.
- PO Split UI suite: 12/12 passed.
- Authoritative schedule/status suite: 44/44 passed.
- Coverage: 100% statements, branches, functions, and lines.
- Focused ESLint and application TypeScript checks: passed.
- Mutation testing: 8/8 killed, post-restoration tests passed.
- Secret scan: passed with no high-confidence findings.
- Source-state manifest: passed.
- Gauntlet exit code: 0.

The gauntlet's project auto-teardown completed. All additional diagnostic test projects, networks, and the two disposable test image tags were then explicitly removed. The three production containers remained healthy. No deployment was performed.
