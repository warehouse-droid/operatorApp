# PO/TO Schedule and PO Split status parity — 2026-10-01

The app was deployed at `2026-10-01T14:05:45Z`. The deployed read-only checks
passed for all 1,136 comparable catalog records, including 311 source/split
records with a current or stored Queued/Hold status. There were zero status or
active-plan mismatches. SN1401822 is Queued in PO/TO Schedule, PO Split list, and
PO Split detail, with `dispatchPlanned: false`.

## Root cause

SN1401822 is the dispatch reference for NetSuite source PO POB03973, internal
ID 1029248. Its exact schedule row, ID 69521, was Queued with revision
`2026-10-01T13:20:18.825092Z`. The linked source had initial status Hold and an
older reconciliation target reporting Hold. The catalog's separate status
precedence allowed that linked Hold to replace the current exact Queued status.

The PO Split card also displayed a Planned badge when its planning description
contained supplier notes, an ETA, or a driver, even without an active dispatch
assignment. This explained the simultaneous Queued, Hold, and Planned labels.

The population check found a further identity case: a source card can retain its
NetSuite PO number after the mirror gains a dispatch alias. Its displayed status
must follow the current alias, while its editable revision must stay tied to the
exact identity being edited.

## Repair

- Both PO Split list and detail now use PO/TO Schedule's existing status query
  for identities present in that view, including assignment, cancellation,
  reconciliation, and completion evidence.
- The internal query accepts a bounded batch of up to 201 references, covering
  a catalog page and its lookahead. A status-only projection avoids unnecessary
  detail hydration. Normal schedule response behavior remains unchanged.
- Source cards resolve their current dispatch alias for status and planning
  display. An alias's revision is never copied into the source's write identity.
- Cards display the current status explicitly. Notes no longer infer Planned.
- The client script cache key is advanced to `20261001-status-parity-v1`.

Linked fallback remains available for catalog identities that the schedule
correctly excludes. No production PO statuses, catalog data, or schema were
rewritten as part of this repair.

## Automated verification

The original production-shaped status and badge regressions failed before the
repair. The source-alias regression also failed before its corresponding fix.

The final run passed 98 tests, including all 12 saved schedule statuses, active
and cancelled assignments, Hold with an active plan, wrong assignment kinds,
linked-source completion isolation, catalog pagination and workload, stale-save
rejection, two-writer concurrency, split editing, remaining quantities, and
authoritative completion history.

Six Chromium status cases passed with no page errors. Syntax checks passed, the
changed files introduced no new lint findings, and the changed patch secret scan
found no findings. The deployed dependency tree imported successfully.

## Live read-only checks

Each audit uses a REPEATABLE READ, READ ONLY transaction and rolls back. It reads
every eligible catalog page, then batches all active mirror and catalog schedule
references so the normal 1,000-row schedule limit cannot truncate coverage. It
compares status and active-plan flags for all comparable records. For every PO
with a current or stored Queued/Hold status, it also reads the split detail.

The original app had 57 disagreements among the 209 Queued/Hold-related records
reached by its capped schedule scan. The tested candidate scanned 1,183 catalog
records and matched all 1,136 comparable records. Its detailed cohort contained
262 source records and 49 split records, with zero status or planning mismatches.

The complete deployed audit independently scanned 1,183 catalog records and
again matched all 1,136 comparable records. All 311 records in the detailed
Queued/Hold cohort passed. Its currently Queued/Hold records represent 87
distinct schedule identities; 94 catalog cards cover these identities and their
aliases. The distinct current identities were:

| Type | Queued | Hold | Total |
| --- | ---: | ---: | ---: |
| Source | 11 | 67 | 78 |
| Split | 2 | 7 | 9 |

Counts are from the deployed audit's consistent snapshot. The detailed cohort
also includes records whose stored Queued/Hold status has since advanced to
another current status.

Two Hold POs, POB03845 and POB03975, await supervisor approval and are correctly
absent from PO Split. Five closed source POs are correctly absent from the
schedule; each split list and detail still agrees on Hold: 22011307, POB03960,
POB03934, POB03659, and SN1397066. Six extra references in the original capped
schedule search were inactive records from cancelled groups or unsplit POs.

The targeted deployed SN1401822 check retained schedule ID 69521 and the exact
original revision. It found no dispatch assignments and no false Planned state.

## Deployment

Only four runtime files were overlaid on the captured production app image:
`src/dispatch-repository.js`, `src/scm-purchase-order-catalog-repository.js`,
`public/dispatch-scm.js`, and `public/dispatch-scm.html`.

Only the app container was recreated. Runtime configuration and dependency
containers are unchanged. Health, the complete source/migration tree, and served
JavaScript/HTML hashes were verified. The previous image is retained for rollback.

Image: `mbbs-operator-app:scm-status-parity-20261001`

Image ID:
`sha256:7673597a2a94a6a63b0bc7a9b5b829cadf3080944b01aa5d936210d8ce61fd75`

## Artifacts

- [Original live audit](../test-artifacts/scm-status-parity-20261001/production-before.json)
- [Candidate full-population audit](../test-artifacts/scm-status-parity-20261001/candidate-population.json)
- [Deployed full-population audit](../test-artifacts/scm-status-parity-20261001/production-after.json)
- [Summary of deployed results](../test-artifacts/scm-status-parity-20261001/audit-summary.json)
- [Every Queued/Hold check, including exclusions](../test-artifacts/scm-status-parity-20261001/queued-hold-audit.csv)
- [Deployed SN1401822 check](../test-artifacts/scm-status-parity-20261001/production-sn1401822.json)
- [98-test regression run](../test-artifacts/scm-status-parity-20261001/final-regressions.log)
- [Browser checks](../test-artifacts/scm-status-parity-20261001/browser-checks.log)
- [Static checks](../test-artifacts/scm-status-parity-20261001/static-checks.log)
- [Deployment result](../deployments/scm-status-parity-20261001/result.json)
- [Scoped runtime patch](../deployments/scm-status-parity-20261001/changes.patch)
