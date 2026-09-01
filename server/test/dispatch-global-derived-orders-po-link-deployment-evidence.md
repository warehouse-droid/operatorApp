# Production deployment evidence — global Dispatch orders and PO-link service fees

Date: 2026-08-31 UTC

Assurance tier: Tier 3. This release changes persisted Dispatch order
definitions, cross-date planning visibility, PO allocation validation, and
Driver-visible physical quantities.

## Authorization and scope

- The user explicitly requested that every derived Dispatch order be global,
  that PO links treat a UOM mismatch as a different item, that users choose the
  MBBS-Special service-fee lines, and that the result be deployed with a short
  cutover.
- A separate pre-implementation spec-approval checkpoint was not obtained; the
  implementation already existed when this deployment evidence pass began.
- The production payload was isolated from the dirty worktree to migration 192,
  11 runtime/UI files, and the migration readiness inventory entry. Unrelated
  SCM, MBT, schedule, webhook-worker, and test-only changes were excluded.
- No dependency or lockfile changed.

## Final predeployment checks

- Fresh isolated migration replay through
  `192_dispatch_global_derived_orders.sql`: exit 0.
- Global-order integration/property/optimization packet: 19/19 passed.
- PO-link UI, Driver route, and service-fee packet: 22/22 passed.
- Focused UOM-mismatch and explicit-service-fee database regressions: 2/2
  passed; 11 unrelated cases were intentionally excluded by name pattern.
- Migration upgrade and readiness packet: 7/7 passed.
- Exact runtime-payload ESLint: exit 0 with zero warnings.
- Candidate import, server syntax, browser-asset syntax, and 13/13 candidate
  file-hash comparisons: passed.
- Repository-wide TypeScript baseline was not green: four implicit-`any`
  errors remain in the unrelated pre-existing
  `test/support/run-scm-manual-split-authority-mutations.mjs`. No error was in
  this release payload.
- The production readiness inventory, in required read-only mode, reported
  `missingMigrations: []` and `dispatchCollisions: []`; it returned non-ready
  because seven MBT feature flags are intentionally enabled in production.

## Backup, migration, and cutover

- Backup:
  `docker/backups/mbbs-before-global-orders-po-link-20260831T233054Z.dump`
- Backup size: 173,180,795 bytes.
- Backup SHA-256:
  `63a40ab60977107a863db99003d4c9e4ff24b1bd05011edc3abfdeb3c1217e60`.
- `pg_restore --list` validated 3,071 archive entries.
- Migration 192 was applied while the previous app remained healthy.
- Previous image / rollback image:
  `sha256:b895576cb9c3d35467ad9b2d744f63bbf931f9cec891226c6681165434e5793c`
  under tag
  `mbbs-operator-app:rollback-pre-global-orders-po-link-20260831T233054Z`.
- Release image:
  `sha256:7df3d787f09b3395e7ed0fb7c57aad78600a18e0f9f97b5c4edd3ec851ae61ae`
  under tag
  `mbbs-operator-app:global-orders-po-link-20260831T233054Z`.
- Only the app container was recreated. The health-gated cutover completed in
  7.70 seconds. PostgreSQL and the webhook worker retained their original
  start times and restart count zero.
- The rollback image completed a read-only repository query against the
  migrated schema, proving backward schema compatibility.

## Live acceptance evidence

- Local and public HTTPS `/health` returned HTTP 200.
- The running container is healthy with restart count zero and the release
  label `dispatch-global-orders-po-link-uom-service`.
- Startup reconciled current CO pickup metadata on 147 global order
  definitions; startup logs contain no error.
- A September 1 bootstrap plus global-pool query returns both
  `CO-TOB01014` and `CO-TOB01015`.
- `TOB01014` now has source/pickup yard `12441`, with transit CO from `2967` to
  `12441`.
- `TOB01015` now has source/pickup yard `12441`, with transit CO from `3445` to
  `12441`.
- Migration backfill currently contains global SO/PO/CO groups and global
  SO/PO/TO/CO split definitions. Automated coverage also proves local
  consolidation TOs, COs of splits, groups of splits, and grouped COs.
- The public Dispatch asset is the
  `20260831-po-link-uom-service-v2` generation and contains the global UOM
  mismatch rule, explicit SO/PO service-fee selectors, and
  `serviceSalesLineKeys` request field.
- No production allocation was created solely for smoke testing; service-line
  persistence and exclusion from Driver/vendor/yard physical work were proven
  in the isolated database regressions.

## Honest deployment notes

- The first overlay build used a raw image digest in `FROM`; BuildKit tried to
  resolve it as a registry repository and failed. Rebuilding from the already
  verified local rollback tag succeeded without changing the payload.
- Two initial HTTP smoke assertions called protected Dispatch APIs without
  credentials and received authentication responses. They were replaced by
  read-only repository checks inside the running production container; public
  verification remained limited to health and static assets.
- No fresh whole-repository suite was run for this deployment because the
  worktree contains many unrelated pending features. The release was instead
  constrained by live-to-workspace file isolation and the focused packets
  above.
