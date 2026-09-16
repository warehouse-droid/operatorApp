# NetSuite orderLine storage and combined IR release

## Scope

Persist the actual source item-sublist orderLine separately from the stable
transaction line unique key for SO, PO, and both TO stages. Carry it through
readers, reconciliation, mirrors, webhook receivers, and both SuiteScript senders.
Preserve legacy payload mappings and invalidate mappings on source identity change.

Include the other thread's SN1400625 IR fix exactly as verified:
`53caf054ea8ad34c6a87cf7e6c71e3d0ba683858067767fc92c81a914d9cb8db`.
It excludes inactive historical parent PO lines from IR identity validation while
retaining validation of active and selected source identities. No direct-posting
optimization or relaxation of IF/IR quantity checks is part of this release.

## Verification

- Additive migration 202 is rerunnable; invalid mappings fail constraints.
- Tests cover reordering, repeated items, nonconsecutive REST lines, TO physical
  accounting rows, legacy/rekeyed webhooks, split inheritance, actual HTTP readers,
  reconciliation and PO history refresh.
- Unit/property checks exercise 200 explicit identity cases, 150 shuffled physical
  TO cases, and 200 backfill matching cases.
- Five identity faults are each killed independently by unit and property tests.
- Conditional backfill writes reject changed source, item, stable key, timestamps,
  mapping, and active status; a newer webhook wins. Mapping writes preserve every
  operational field, including inactive status.
- RED logs retain evidence for unimplemented behavior, TO stage leakage, subtotal
  exclusions, and inactive source coverage. Fixture corrections are documented in
  `test/order-line-storage-spec.md`.
- Supplemental legacy sync regression: 20 pass, one existing SO reconciliation
  harness failure (`deferredFamilies`, line 555), reproduced on unchanged baseline
  in `legacy-so-baseline.log`.

## Final verification results

- Focused regression: 55/55 pass; shuffled order also passes.
- Combined order-line/IR compatibility: 74/74 pass, including SN1400333 and
  SN1400625, real database tests, and randomized identity cases.
- Changed executable application lines: 185/185 covered (100%). New
  domain branch coverage: 93.33%, 100%.
- All five injected identity faults are killed independently in both layers.
- Type diagnostics: 233 before and 233 after, zero new.
  Lint diagnostics: 1166 before and 1166 after, zero new.
- Full unchanged baseline: 494 files; 2,507 pass, one fail, one skip.
- Full frozen combined release: 500 files; 2,541 pass, one fail, one skip.
  The identical pre-existing failure is P3.12's browser fixture import check in
  `p3-gauntlet-contract.test.js` (the existing dispatch-unpacked-split browser
  spec imports Playwright directly). The full suite is not entirely green;
  neither deployed fix introduces a new failure. No test was weakened.
- Final checks and compatibility manifests pin every reviewed source file;
  runtime/image inventories prove no unrelated workspace changes were included.

## Deployment and live backfill

Both app and webhook worker deployed together at 2026-09-16T14:58:13.989328+00:00:

- Image: `mbbs-operator-app:order-line-storage-ir-20260916-v3`.
- Image ID: `sha256:964fbe441b8030c3645e011e450aca6ebd943d163c38e3baa898821ce3c16010`.
- Migration: `202_netsuite_order_line.sql`, with schema and affected-table
  backups retained in the private release directory.
- Exactly 14 runtime/schema/script/tool files over the pinned production image.
  Environment, mounts, ports and commands were preserved. DB and other dependency
  containers were unchanged. Final app/worker restart counts are zero.
- Local and public health endpoints return HTTP 200. All six new mapping/time
  columns are present. The exact reviewed IR source hash is included.

Final read-only coverage at 2026-09-16T15:02:16.816Z:

| Kind | Incomplete source orders | Mapped source rows | Split orders | Inherited split rows | Mismatches |
| --- | ---: | ---: | ---: | ---: | ---: |
| SO | 200 | 688 | 6 | 13 | 0 |
| PO | 47 | 349 | 87 | 249 | 0 |
| TO | 7 | 40 | 0 | 0 | 0 |

The application now has 1,077 mapped source rows and 262 inherited split rows
across the 254 eligible incomplete source orders. Eight previously missing local
orders were imported through the existing targeted sync flow:
SOV00934, SOV02136, SOR00033, SOR00043, SOV02191, POV00049, POT00037, POB03879.

The first apply wrote 1048 existing source mappings. Six transaction-level
before/after checks covered 1379 source/split rows and confirmed that every
operational field was preserved. New import rows obtained mappings through the
normal upserts. Existing cached mappings supplied the remaining source coverage.
Six inactive SO source rows were mapped without reactivating them.

A second actual apply completed at 2026-09-16T15:01:43.908Z with zero updates,
missing orders, unresolved identities, or write conflicts for every order kind.
It repeated the operational-field preservation checks. The final split inheritance
query found zero mismatches.

Explicit exclusions: 15 non-fulfillable SO subtotal rows; 13 inactive SO and
12 inactive PO historical rows absent from NetSuite; SOT14140 and SOT14715 under
the existing cross-charge exclusion policy. Completed/billing-only orders are
outside incomplete fulfillment/receiving scope. These exclusions are retained
in the durable JSONL plan/apply reports, not silently counted as mapped.

The deployed IR code also passed a live read-only SN1400625 draft replay:
source PO 939701; memo SN1400625; orderLine 1/24/25 with quantities 360/360/288.
Inactive historical parents remain excluded. No receipt was submitted.
NetSuite transaction records were never created or edited for this work.

Evidence is under `test-artifacts/order-line-storage/`, especially
`regression-summary.json`, `checks.json`, `static.json`, `deployment.json`,
`backfill-apply.jsonl`, `backfill-idempotence.jsonl`, `backfill-verification.json`,
and `ir-live-replay.json`. Frozen releases/backups are under
`/home/ubuntu/operatorapp-deploy-backups/order-line-storage-ir-20260916-v3`.

## NetSuite sender installation

The application and worker deployment does not update NetSuite's File Cabinet.
The two updated sender files are packaged as
`test-artifacts/order-line-storage/netsuite-orderline-webhook.zip`.
Install the applicable existing direct User Event or scheduled sender file using
`test/order-line-storage-webhook-install.md`; keep its existing deployment/settings.
This environment has no SuiteCloud/File Cabinet deployment access. Live sender
installation remains outstanding and must not be described as completed.
