# Consolidation Load — implementation and release evidence

Subsequent PALLET-unit and calendar-date fixes are recorded in [the display correction report](operator-display-fixes-evidence.md). The original release results below are retained.

Implemented the [approved specification](consolidation-load-spec.md). Delivery Prep now offers Consolidation Load in place of Saved Orders, with same-load multi-selection, date/truck filters, an Order / Item / Quantity preview, and shared loading photos. Ordinary Delivery Prep and Customer Pickup summaries use the same compact quantity formatter.

Sales Order loading creates neither a Sales Order native posting command nor a driver completion event. Driver/backend completion retains fulfillment ownership. Existing backend Transfer Order posting gates remain authoritative; the PWA supplies no IF decision.

## Frozen source and deployment

- Baseline commit: `c82c71d6632ffef21ff0a77c3dabbce542f805e2`.
- Final source tree SHA-256: `51f93ba018d5bf8c8863894c4a3125be9d0b810a8c9200616e410a9512769d79`.
- Deployed at: `2026-09-15T05:30:40Z`.
- Release image: `mbbs-operator-app:consolidation-load-20260915-v1`.
- Migration: `200_operator_consolidated_loads.sql`; both batch and claim tables verified.
- All 21 production files in the running app matched the frozen source hashes.
- Health endpoint, Docker health, app/worker running status with zero restarts, and ten served page/asset URLs verified. PWA cache: `mbbs-yard-operator-v146-consolidation-load-v1`.
- Pre-rollout backup: `backups/consolidation-load-20260915/pre-rollout.dump`, 289,389,762 bytes, mode `0600`. `pg_restore` read the entire archive successfully before migration.
- Rollback image: `mbbs-operator-app:operator-yards-20260915-v1`; rollout/rollback Compose files are under `docker/backups/consolidation-load-20260915/`. Rollback preserves the additive tables and accepted batch evidence.

## Final clean verification

Run from the repository root:

```sh
bash server/tools/consolidation-load-gauntlet.sh
```

The runner freezes production and verification files, uses disposable PostgreSQL databases on internal Docker networks, and reruns the frozen baseline separately. It rejects changed source hashes, new static diagnostics, new regression failures, uncovered changed executable lines, surviving mutants, or secret findings. No package dependencies changed.

| Check | Final result |
| --- | --- |
| Focused domain, posting, HTTP/database and asset checks | 34 passed; no failures or skips |
| Consolidation Load and Dispatch browser cases | 19 passed; no failures or skips |
| Browser coverage execution | 5 passed |
| Existing Operator E2E cases, Chromium desktop/mobile and WebKit mobile | 72 passed |
| Current full suite | 2374 tests; 2371 passed, 2 existing failures, 1 existing skip |
| Frozen baseline full suite | 2343 tests; 2340 passed, 2 failures, 1 skip |
| Types | 233 baseline / 233 current diagnostics; zero new |
| Lint | 66 baseline / 66 current diagnostics; zero new |
| Changed executable JavaScript lines, V8 coverage | 609 / 609 covered |
| Realistic mutants | 5/5 killed by focused tests; 5/5 killed by properties alone |
| Secret scan | Passed for new tooling paths and the full task diff |

The same two infrastructure failures occurred in both full runs; they are not claimed as passes:

- P3.12: browser specs share one worker-owned database-pool lifecycle
- quality non-regression: the gauntlet builds and validates the omit-dev runtime

The existing skipped check is the opt-in migration 175 cross-charge rehearsal. Exact outputs are retained in [final-results.json](../test-artifacts/consolidation-load/final-results.json), [full-final.log](../test-artifacts/consolidation-load/full-final.log), and [baseline-full-final.log](../test-artifacts/consolidation-load/baseline-full-final.log).

## Behavior demonstrated

- Unit and property checks verify zero-unit omission, sales-unit fallback, compatible duplicate aggregation without cross-order merging, quantity conservation, date/truck/numeric sequence ordering, original child-yard filtering, and snapshot stability/drift detection.
- Real HTTP/PostgreSQL checks cover SO, TO, CO, VRMA, Dispatch groups, stale quantities/assignment, forged IDs/photos, owner and yard revocation, simultaneous submissions and overlapping batches. A forced second-order failure leaves every original order unchanged; retry writes each original load record once.
- Ordinary packing, page confirmation, saved draft release, consolidation picking, and unpacking retain their behavior. All ten edit entry points reject changes to an order claimed by a pending batch.
- Backend native posting tests use the real resolver, durable command/step repository, runtime, verification, and finalizer. Failures before and after a verified TO step retain the whole local batch; retry preserves verified remote work. Mixed loads produce no SO native targets.
- Browser cases exercise selection, filters, stale-preview recovery, camera capture, partial upload retry, shared photo references, refresh/recovery of a pending load, and a late completion response arriving after a different preview opens. Mobile layouts were also visually inspected.
- Migration upgrade and transactional rollback rehearsals verify that existing batch evidence is preserved. The production migration is additive.

Initial RED logs captured missing behavior and actual defects, including noncanonical JSONB snapshot hashes, overlapping individual admission, lost browser focus/photo-upload state, and the late completion response. An initial final-run coverage gap led to the added packing and child-yard regression cases. The final results above come from a fresh run after the last implementation/test edit.

Mutants represented zero units reappearing, duplicate quantities being overwritten, ignoring physical load identity, ignoring snapshot quantity drift, and allowing SO native target materialization. Details: [mutations.json](../test-artifacts/consolidation-load/mutations.json), [changed-coverage.json](../test-artifacts/consolidation-load/changed-coverage.json), and [source-hashes.json](../test-artifacts/consolidation-load/source-hashes.json).

Validation uses Node v20.20.2, fast-check 4.9.0, ESLint 10.8.0, TypeScript 7.0.2, and c8 12.0.0. Camera hardware and external photo-storage/NetSuite transport were simulated at their boundaries; production smoke checks did not load operational orders or post fulfillment records. Real-device camera and live remote-system behavior were not exercised by these tests.

```text
/mbbs-operator-app-app-1 mbbs-operator-app:consolidation-load-20260915-v1 running restarts=0 healthy
/mbbs-operator-app-webhook-worker-1 mbbs-operator-app:consolidation-load-20260915-v1 running restarts=0
```
