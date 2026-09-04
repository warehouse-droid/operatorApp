# Evidence — SCM PO NetSuite line sequence and pallet conservation

Status: deployed, repaired, and verified in production on 2026-09-03 UTC.

## Production witness

- NetSuite `POB03774` has three active `PALLET` item lines: `6 + 3 + 4 = 13`.
- Completed child `SN1399024` carries `4` PALLET units but its split ledger still
  references inactive source line key `4840837`.
- Active replacement line key `4840839` also carries `4` units, so the stale
  lineage leaves those same four units visible on both parent and child and
  produces `17` across the family.

## RED and GREEN proof

- RED reproduced missing/wrong UI ordering, absent NetSuite line labels, a
  zero-candidate stale-line preview, and the historical `7` versus current `4`
  quantity hazard.
- GREEN focused run passed 7/7 checks, including 128 generated input
  permutations and a rollback-backed family conservation assertion of exactly
  `3 + 4 + 6 = 13`.
- The existing receipt-baseline confirmation/reassignment rollback harness
  remained green.

## Gauntlet

- Focused executable specification: 7/7 checks passed, including 128 generated
  input permutations.
- Adjacent SCM split suite: 38/38 checks passed.
- Manual mutation score: 8/8 mutants killed and every source hash restored.
- Phase 3 mutation-registry contract: 10/10 checks passed.
- Complete isolated Node regression: 439/439 files and 2,194/2,194 tests passed.
- Changed-file syntax, type analysis, zero-warning focused lint, coverage probes,
  clean-workload checks, and `git diff --check` passed.

## Backup and release

- Verified pre-repair PostgreSQL custom dump:
  `backups/production/pob03774-pre-repair-20260903T030844Z.dump`
- Dump size: 255,945,728 bytes.
- Dump SHA-256:
  `25311a805bd392158a6a0c35134f9de0c9cec9d522b346a35593345f031e37a0`.
- Parent production image:
  `sha256:519b31a355fe0ee62dd40fafe520e436bf0b1068d53a6e361ecc5d669875032b`.
- Deployed seven-file child image:
  `mbbs-operator-app:po-line-sequence-conservation-20260903T030844Z`, image
  `sha256:9b80211e3997a8d6e021efc0c07364d5c2c37cd6220ff081991eda523d25b487`.
- All seven in-image file hashes matched the reviewed staging inputs.
- App and webhook worker are running the same image; app health is healthy and
  both restart counts are zero.

## Audited production repair

- Assertion-guarded repair rebound only split ledger `448` for `SN1399024`:
  source line `4840837` / local `348152` to source line `4840839` / local
  `348154`.
- Current PALLET quantity remained `4`; historical requested quantity remained
  `7`; no receipt-baseline reduction was made.
- Reconciliation audit event: `50429`.
- Exact targeted reconciliation run: `1077`, status `succeeded`, one source and
  one reconciled order, zero failed/review/error orders, two NetSuite requests.
- Full SCM refresh outbox `371` and Dispatch refresh outbox `35` completed. SCM
  catalog generation advanced from `297` to `298` with no error.

## Live post-repair result

- NetSuite exposes sequence numbers `1` through `8`; its three PALLET/EACH
  lines are sequence 5 = `6`, sequence 7 = `3`, and sequence 8 = `4`, total
  `13`.
- The browser catalog now exposes the family as:
  - `POB03774`: sequence 6 material plus sequence 7 PALLET `3`, status `Queued`,
    not completed.
  - `SN1399024`: sequences `1, 2, 3, 8`, PALLET `4`, status `Completed` with its
    completion evidence retained.
  - `SN1399025`: sequences `4, 5`, PALLET `6`, status `Queued`, not completed.
- Browser-visible family PALLET total: `3 + 4 + 6 = 13`.
- Both split-editor payloads are sequence ordered, and the stale PALLET
  adjustment is no longer offered.
- The completed child's old raw snapshot was not rewritten. Its live sequence
  is projected through the repaired immutable ledger lineage to current
  NetSuite line 8.
- Live health and static assets returned HTTP 200; the served HTML has cache key
  `20260903-po-line-sequence-v1`, and the served JavaScript contains both the
  sequence sorter and visible `NetSuite line` label.

## Rollback

The prior app and worker image can be restored with:

```bash
cd /home/ubuntu/apps/operatorApp
docker compose \
  -f docker-compose.yml \
  -f /tmp/mbbs-po-line-release.we3Ems/docker-compose.rollback.yml \
  up -d --no-deps --no-build --wait app webhook-worker
```

The verified database dump above is retained separately. The disposable test
database/network and stopped live-image extraction container were removed after
verification; no production data volume was removed.
