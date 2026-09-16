# Smart SCM created PO sync — evidence

## Result

Implemented and tested. **Kept ready without deployment, as requested by the user.** Automatic approval review initially rejected restarting the shared application and webhook worker; the user then explicitly chose to retain the prepared release without deploying it. No deployment or production data change was made by this task.

POB03875 (NetSuite ID 991607, workflow 8072, history 55) confirmed the bug:

| Item | Original application proposal | Current NetSuite PO |
| --- | ---: | ---: |
| PER-MEL80S-RDM-NG | 8 PLT | 10 PLT |
| PER-MEL80S-RDM-AB | 5 PLT | 5 PLT |
| PER-MEL60-COP-AB | 10 PLT | Removed |
| PER-MEL60S-RDM-AB | Absent | 8 PLT |
| PALLET | 23 EACH | 23 EACH |

The canonical local order already contained NetSuite's changed items and quantities, but Vendor Replies displayed the immutable proposal rows. The deployed webhook omitted financial fields; the history handler cleared the canonical rate and amount when those fields were missing.

## Implemented behavior

- Linked regular POs display the full current canonical line set, including additions, replacements, deletions, changed destinations, native quantities, prices, PALLET lines, weights, and capacity usage. Original proposals and creation evidence remain intact.
- **View / Edit PO** opens the existing editor directly from Vendor Replies without archiving. Existing history browsing remains archived by default. Supported edits are dates, memo, vendor reference, quantity, rate, and destination; received/closed/inactive orders remain protected.
- **Sync from NetSuite**, webhook notifications, and a bounded refresh every 60 seconds while Vendor Replies is visible keep current POs fresh. Focused editors defer the timed refresh.
- Missing webhook prices preserve known financials. Explicit zero values and authoritative reconciliation still work.
- Content versions detect same-day changes even when SuiteQL returns date-only modification values. The service and outbound adapter both check the version. Canonical refresh writes run in one transaction.

## Validation

Spec approval: **not obtained (autonomous run)**. Tier 3 because this concerns PO financial data and synchronization. No new dependencies or migrations. No checkpoint commits. Unrelated working-tree changes were preserved.

| Check | Final result |
| --- | --- |
| Focused tests and neighboring PO/vendor/conversion regressions | **58 passed, 0 failed** |
| Changed backend line coverage | **185/185 (100%)**, across six modules |
| Mutation tests | **7/7 deliberate bugs caught**; three projection mutants also caught by the property suite alone (**10/10 checks**) |
| Property tests | 150 seeded generated line sets verify identity, quantity conservation, active-line filtering, and idempotence |
| Browser execution | Chromium verified current item rows, manual refresh, direct unarchived editor, and versioned save; **0 browser errors** |
| Full repository suite | 2,395 tests: **2,392 passed, 2 existing failures, 1 skipped**; all 472 files ran |
| Pre-change full-suite baseline | 2,375 tests: 2,372 passed, the same 2 failures, 1 skipped; 468 files |
| Type checking | The same **233 pre-existing TypeScript diagnostics**, with no new diagnostics |
| Scoped lint | The same pre-existing unused `WORKFLOW_KINDS` declaration; no new findings |
| Syntax | All changed backend/browser files and the server entry point passed |
| Secrets | Passed; no new high-confidence findings |

The unchanged full-suite failures are `P3.12: browser specs share one worker-owned database-pool lifecycle` and `quality non-regression: the gauntlet builds and validates the omit-dev runtime`. Their exact names and the baseline type diagnostics are checked in alongside this report.

### Acceptance criteria mapping

- Production-shaped quantity/replacement, missing data, deleted rows, duplicate identities, destinations, and totals: `test/mbt/unit/smart-scm-created-po.test.js`.
- Real PostgreSQL projection, creation evidence, partial webhook prices, explicit zero, reconciliation, and history versions: `test/mbt/integration/smart-scm-vendor-unit-price.test.js`.
- Unarchived edits, same-day conflicts, terminal orders, failed refresh transaction boundary, and the final outbound version recheck: `test/mbt/unit/smart-scm-created-po-service.test.js`.
- Canonical/remote version equivalence: `test/mbt/unit/scm-netsuite-po-version.test.js`.
- UI actions and refresh guards: `test/mbt/unit/smart-scm-created-po-ui.test.js` and `tools/smart-scm-created-po-sync-browser.mjs`.
- Existing pricing, Blanket, PO review, conversion, and event behavior: neighboring suites included in the gauntlet.

### Reproduce

From `server/`:

```sh
sudo -n bash tools/smart-scm-created-po-sync-gauntlet.sh
```

This uses temporary PostgreSQL containers on an isolated network and the existing test images. `--focused` runs all focused layers and Chromium without repeating the full repository suite. Tests use Node v20.20.2, ESLint v10.8.0, c8, fast-check, and the installed Playwright Chromium image. The scripts record source hashes and coverage inputs before execution.

Outputs: `test-artifacts/smart-scm-created-po-sync/gauntlet.json`, `changed-coverage.json`, `changed-lines.json`, `mutations.json`, test logs, and screenshots `vendor-replies.png` and `po-editor.png`. Full-suite comparison logs are retained at `/tmp/smart-scm-created-po-full-baseline.log` and `/tmp/smart-scm-created-po-full-final.log`.

## Release prepared

- Application image: `mbbs-operator-app:scm-po-sync-20260915-v1`.
- Worker image: `mbbs-operator-app:scm-po-sync-worker-20260915-v1`.
- Source backups, release contexts, per-file hashes, and Compose override: `/home/ubuntu/operatorapp-deploy-backups/smart-scm-created-po-20260915/`.
- Each image layers the task's changes onto that service's existing deployed image. The server entry point receives only the single route change; other deployed server changes are preserved.
- Rollback images remain `mbbs-operator-app:operator-display-20260915-v1` (application) and `mbbs-operator-app:consolidation-load-20260915-v1` (worker).

Deployment is intentionally deferred. If the user later authorizes deployment: deploy both images, check service health, refresh POB03875 through the PO history service, compare the returned Vendor Replies rows with a fresh NetSuite read, and verify its creation snapshot did not change.

## Limits and investigation notes

- NetSuite was read live; no live NetSuite PO was created or changed. Outbound writes were tested at the network boundary with fixtures. Deployment and live post-deployment verification are deferred by the user's instruction.
- The final NetSuite read and PATCH are separate requests. Content checks catch stale edits and recheck immediately before PATCH, but do not provide an atomic cross-system transaction against a simultaneous NetSuite edit.
- No new package was installed, so a new-dependency audit was not applicable. The existing project type configuration does not enforce strict typing on all Smart SCM JavaScript; behavior, syntax, lint, coverage, mutation and database tests provide the task-specific checks.
- Regression tests were observed failing before the fixes. The weight fixture's arithmetic and its source-versus-review audit assertion were corrected explicitly in the append-only spec. Exact cache-version tests were updated to require the new assets. A malformed SQL mutant was corrected to introduce a real price-erasure bug rather than a SQL type error. Coverage harnesses preserve source offsets so VM-executed service tests map to the actual changed lines.
