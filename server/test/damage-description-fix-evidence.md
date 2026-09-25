# Damage description correction — 23 September 2026

The first submitted damage report was durably saved, but NetSuite rejected its
line description with HTTP 400: the field permits at most 40 characters. The
original SKU plus report marker exceeded that limit. New lines now use `DMG:`
and the complete UUID (40 ASCII characters). Reconciliation and monthly review
recognize both this format and the original marker.

The [acceptance specification](damage-description-fix-spec.md) was implemented
under existing fix authorization; additional spec approval was not obtained
(autonomous run).

- Two new contract tests first reproduced the actual rejection for create and
  append. All **47 inventory feature tests** then passed in the workspace and
  the exact release candidate, including legacy markers and duplicate retries.
- Full repository run: **3,080 tests; 3,055 passed, 24 existing failures,
  one skipped; zero new failure names** against the recorded baseline.
- All six changed executable lines were covered. The changed service had 100%
  statement/line/function coverage and 89% branch coverage; the full feature
  coverage gate passed. An initial service-only coverage invocation failed the
  repository's global 90% branch gate; the final run used the existing complete
  inventory feature coverage scope without lowering any thresholds.
- Three targeted mutants were killed: overlong description, missing identity,
  and missing original-marker reconciliation. All seven feature test files also
  passed in a different order. Existing property cases passed.
- Lint, syntax and strict domain type checks passed. Project type comparison:
  174 existing normalized diagnostics, zero new. Secrets scan passed; no new
  dependencies. No schema change or transaction rollback was needed.
- Only `src/inventory-damage-service.js` was deployed over the current Receiving
  image at **20:47:04 UTC**. All **1,021 production source/asset/migration hashes**
  matched the intended image; settings and other services were preserved.
  Local/public health and Operator returned 200; unauthenticated damage API 401.

Image: `sha256:000c86957d0d21c071d1816978e4221a3eabd3598809c301793db0ff3aeb1283`.
Reproduce with `bash tools/damage-description-fix-checks.sh`. Source and tool
versions are recorded in
`test-artifacts/damage-description-fix/damage-description-fix/sources.json`.
Release/rollback metadata is in
`/home/ubuntu/operatorapp-deploy-backups/damage-description-fix-20260923-v1`.

Live NetSuite reads confirmed IT00551 (998187), source 1, damage destination 10,
memo `3445 2026 Sep Damage`. Automatic approval review initially rejected retry
because real inventory movement required explicit authorization. The user then
approved exactly one retry for UNI-WIN70S-0714-DC, 275.64 SQFT. NetSuite accepted
that PATCH, but the immediate read did not confirm the report marker, so the
application safely kept the report in attention with automatic resending blocked.
The user independently confirmed success, manually removed the line in NetSuite,
and explicitly requested local removal.

`tools/damage-report-local-removal.mjs` verified the item and marker were absent
from the complete live transfer. Under the monthly lock and a database transaction,
it removed exactly one report, one photo reference and three dependent local events.
The monthly transfer binding and every other report were preserved. No NetSuite
write was made during cleanup. A private complete pre-removal backup and execution
receipt are saved as `local-removal-backup.json` and `local-removal-result.json`
in the release backup directory above. The cleanup checked the backup SHA-256
before removing anything. The external photo object was retained in storage.
