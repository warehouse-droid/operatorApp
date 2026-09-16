# Operator unit and calendar-date display corrections

Deployed `2026-09-15T06:04:09Z` as `mbbs-operator-app:operator-display-20260915-v1`, based on the previously verified Consolidation Load release.

The PALLET item was incorrectly overriding its source sales unit with the item name in both the compact summary and quantity-entry labels. Both now use the order line's actual NetSuite unit, including `EACH`. Different sales units remain separate in aggregated rows; physical conversion formatting is unchanged.

Read-only production checks found SOB119935 (986223) and SOB119962 (986352) assigned to confirmed plan 322, **2026-09-10, CE94487, Load 3**. Their expected and planned dates reached the PWA as `2026-09-10T00:00:00.000Z`. The Active list treated those calendar fields as Toronto timestamps and displayed September 9. Operator calendar-date formatting now preserves the calendar day, matching Consolidation Load. Event/history timestamps still use Toronto time.

Verification:

- The original unit override and date shift were reproduced by failing regression checks before the fixes.
- 32 unit/asset checks passed, including EACH/EA preservation, distinct units, January/DST boundaries, Chinese dates, timestamp handling, and service-worker cache behavior.
- 5 browser scenarios passed across desktop Chromium, mobile Chromium, and mobile WebKit; the added checks compare the reported orders' dates in Active view and Consolidation Load, and verify `4 EACH` in the load summary.
- 72 existing Operator browser cases passed, including confirmed/remaining EACH quantities in Customer Pickup.
- Frontend lint: 36 baseline diagnostics, 36 current, zero new. `git diff --check` passed.
- Only four frontend files differ from the prior verified image. Every backend and migration hash matches that release. No database migration or operational-data repair was needed.
- All 21 production-file hashes matched inside the deployed app. Health, zero app restarts, and the exact served HTML/JS/service-worker hashes were verified. The existing worker container was preserved.

PWA cache: `mbbs-yard-operator-v147-display-v1`. Rollback and rollout files: `docker/backups/operator-display-20260915/`. Test logs, source/test hashes and deployment evidence: `server/test-artifacts/operator-pallet-uom/`. The browser checks simulate API/camera/storage boundaries; no operational orders were loaded as a smoke test.
