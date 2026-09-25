# Grouped delivery loading and unpack identity fix

Completed 2026-09-17. Spec: [group-load-identity-spec.md](group-load-identity-spec.md).
spec approval: not obtained (autonomous run).

## Root cause and release history

GOA-8601-8604 is a virtual dispatch group containing SOA08601 (988739) and
SOA08604 (988858). The group projection inherits `order_type: sales_order`.
The CO source-packing guard collected both that projection and its canonical
children, then supplied all their IDs to `ANY($1::bigint[])`. PostgreSQL rejected
the virtual GOA ID with 22P02 before loading could proceed.

Archived images establish the regression boundary: the image tagged
`rollback-direct-to-same-yard-20260916` has neither the guard module nor its
loading call. `direct-to-same-yard-20260916-v1`, whose deployment result was
recorded on September 16 at 23:38 UTC, has the faulty query. Later CO releases
retain it. Successful group-load audits precede that deployment, including
GOA-8600-8648 at 14:00 UTC and GOB-120448-120451 at 19:14 UTC on September 16.
The defect applies to sales-order groups reaching this guard, not only this pair.

The same live group's unpack errors came from passing a GRPLINE text ID into
the bigint audit `line_id`. That separate identity error is also corrected.

## Changes and verification

- Group source-packing checks now select the canonical children; standalone
  orders continue to check their own identity. Existing CO, yard, transaction,
  concurrency, photo and quantity policies remain intact.
- Group-line unpack records `details.groupLineId` and leaves numeric `line_id`
  null. Actual child-line updates and audit rollback behavior are unchanged.
- RED: the original implementation fails six of eight focused scenarios,
  reproducing both reported classes of 22P02 error. Standalone SO and grouped TO
  controls pass. An early combined test run exposed an unscoped test record
  count; the assertion was corrected to select this group's records.
- GREEN: 62 tests pass in both normal and reversed file order, comprising eight
  new scenarios and 54 existing CO handoff, group packing and consolidation
  tests. A seeded property checks every possible child position, reversed
  ordering, and active/cancelled CO ownership across 30 generated cases.
- Both changed executable lines have coverage. All five manual mutants are
  rejected: including the virtual group, skipping group checks, checking only
  the first child, restoring the invalid numeric audit ID, and losing the text
  audit identity.
- Syntax and secret checks pass. Type and lint comparison reports no new
  findings: 3,048 existing type diagnostics across the imported application
  graph and nine existing lint findings are unchanged. These are baseline
  comparisons, not a claim that the application is globally type/lint clean.

## Production verification

Only the two affected app modules were layered over the existing app image.
The worker and previously corrected inbound/on-order SQL helper are unchanged.
The app health endpoint reports `ok: true`.

Read-only verification at 2026-09-17 14:05 UTC confirms:

- GOA-8601-8604 now passes its CO source-packing check; before deployment the
  same read-only check returned the reported 22P02 error.
- All 220 active sales-order groups run that check without ID conversion errors:
  200 are allowed and 20 retain the expected CO handoff block.
- The affected group's canonical header and packing-state snapshot is identical
  before and after deployment. SHA-256:
  `bce95a446fbbd98ed3563c5ef6175123f55a079dbafd3a3b12ea9d4303f827a7`.
- No actual live load, unpack, or NetSuite posting was performed. Complete load
  and unpack transactions were verified in isolated PostgreSQL.

Release: `mbbs-operator-app:group-load-identity-20260917`.
Rollback image, compose override, frozen source and deployment manifest:
`/home/ubuntu/operatorapp-deploy-backups/group-load-identity-20260917`.
Raw test, coverage, mutation, release-history and read-only production evidence:
`server/test-artifacts/group-load-identity/`.

Reproduce the database evidence with:
`bash server/tools/group-load-identity-gauntlet.sh` using the existing Docker
test image. The baseline patch reconstructs the exact pre-fix modules without
reverting unrelated work.
