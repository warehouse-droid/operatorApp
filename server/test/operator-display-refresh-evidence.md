# Operator Delivery Prep display fix — 2026-09-18

Implemented against the existing worktree under the approved
[specification](operator-display-refresh-spec.md). The implementation phase made
no deployment or production data write. The user subsequently authorized
[deployment, completed at 16:05 UTC](operator-display-refresh-deployment.md).

## Reproduction and correction

The deployed client reproduced all four defects with the captured read-only
order data: a delayed Active response replaced Packed with 38 open orders
(13 pages); a delayed Packed response emptied Active; Packed fetched five
lists and lost VRMA orders; and the grouped detail hid MBBS-Special Order even
though its API response contained both lines. See
[original reproduction](../test-artifacts/operator-display-repro-20260918/results.json).

Request tickets now bind list, detail and metadata commits to the current
session, yard, screen, filters and revision. Cached lists retain their last
successful snapshot during revalidation. Invalidated prefetches cannot fill a
fresh cache, and update events received during a refresh schedule a subsequent
refresh. Packed fetches SO, TO and VRMA once each. Current manual-refresh errors
show a message while preserving the displayed orders.

For SOB120607-style non-converted sales lines, the original sales quantity
determines the packing basis. A descriptive manual pallet count cannot create
yard work after the sales quantity is fully allocated. SOB120607+SOB120608
therefore displays MBBS-Special Order **2,332 SQFT**, PO allocation **2,332 SQFT**,
yard residual **0 SQFT**, and the **20 EACH PALLET** reference. The planned group
remains discoverable, with yard packing disabled. Partial, cancelled, converted,
physical-only and over-allocated cases retain their respective rules.

The operator script and service-worker cache use the same new release version.

## Verification

Run from `server` with the existing local Docker test images:

```sh
sudo -n bash tools/operator-display-gauntlet.sh
```

The entry point creates a temporary internal PostgreSQL instance and runs
static checks, focused database/unit/property tests, Chromium races, deliberate
faults, test-order checks, changed-line coverage and a baseline comparison of
the full MBT suite. It also checks secrets, whitespace and immutable source
hashes. It does not contact the deployed app or NetSuite.

- The initial five browser regression cases failed before implementation;
  the reference rule/property failed before its correction. Original RED logs
  remain in `test-artifacts/operator-display-fix`.
- Focused checks: **45/45 passed**. Browser checks: **20/20 passed**.
- Property tests exercise 450 generated cases for completion order, navigation,
  invalidation and sales residuals, with a retained deterministic seed.
- All five targeted faults were detected by the property tests themselves:
  missing visit, revision or sequence checks; restoring the old reference rule;
  and incorrectly treating partial allocation as fully supplied.
- Unit files passed again in reverse order: **27/27**.
- Combined Node/Chromium V8 coverage reached **210/210 changed executable lines**.
  The two changed HTML asset lines are checked by the shell/cache contract.
  This is changed-line coverage, not whole-application coverage.
- Syntax and configured lint checks passed. The new request tracker passed
  strict checked-JavaScript types. Project TypeScript diagnostics decreased
  from 246 to 243, with **zero new diagnostics**; existing project diagnostics
  remain.
- A hash comparison of all 2,877 baseline files confirmed that only the five
  intended existing production files changed; no baseline files were removed.
  The refresh tracker, tests, fixtures and verification tools are new files.

The complete entry point **exited 0**. Secret and whitespace checks passed,
and the final source-hash verification confirmed that no source changed during
the run.

The full MBT run completed all **536 files / 2,756 tests**: 2,736 passed,
19 failed and one was skipped. Before this change, the baseline completed
533 files / 2,744 tests: 2,724 passed, the same 19 failed and one was skipped.
Both runs failed in the same 17 files. There were **zero new failing test
names**. The full suite is therefore still not wholly green; its existing
failures are retained explicitly in
[the comparison report](../test-artifacts/operator-display-fix/final/full-comparison.json)
and [the baseline](support/operator-display-baseline-failures.json).

## Artifacts and limits

Final logs, source hashes, coverage, mutation results and screenshots are in
[`test-artifacts/operator-display-fix/final`](../test-artifacts/operator-display-fix/final).
The task-only patch against the preserved worktree baseline is
[`implementation.patch`](../test-artifacts/operator-display-fix/implementation.patch).
The changed-line manifest and known baseline failures are retained under
`test/support/operator-display-*`.

Chromium runs the real public client with deferred HTTP fixtures; database
tests exercise the real repository and rejection paths in isolated PostgreSQL.
Screenshots were visually checked. Service-worker versioning is covered by a
contract test. Deployment subsequently verified public assets, health, access
protection and real order data; see the deployment record. A physical
installed-device upgrade has not been performed.
