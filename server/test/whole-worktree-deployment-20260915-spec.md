# Whole-worktree deployment — 2026-09-15

The user explicitly authorized deployment of the whole worktree, superseding the
earlier instruction to keep the receiving and Smart SCM changes undeployed.

## Release acceptance

- Freeze all current application source, browser assets, migrations and declared
  runtime tooling. Build the standard production Dockerfile with development
  dependencies omitted. Preserve production settings and persistent volumes.
- Compare the complete frozen candidate with the worktree and built image by
  SHA256. Include the pending receiving, Smart SCM and other worktree changes.
- Run the full MBT suite against an isolated fresh database and require no new
  failures compared with the two recorded infrastructure failures. Verify the
  recently changed Dispatch paths and receiving/Smart SCM browser flows.
- Inventory pending migrations before cutover. Retain a private validated database
  backup, previous image IDs and a usable Compose rollback definition.
- Recreate app and webhook worker only. Verify image identity, health, worker
  stability, served asset hashes and PO search/detail behavior. Refresh/check
  POB03875 through the existing PO history service; do not create test receipts.
- If readiness fails after cutover, restore the prior app/worker release and report
  the failure. Database restore is not an automatic rollback action.

Failure model: mixed source snapshots (hash checks), missing runtime dependencies
(production-image startup), schema mismatch (migration inventory), lost settings
(effective Compose comparison), startup failure (health observer and image rollback),
receiving/PO regressions (existing isolated suites and live read-only checks).

Use existing Docker/Node/PostgreSQL tooling. No dependencies or commits are added.
Freeze source and retain deployment evidence under the private deployment backup
directory. Existing feature specs remain the executable behavior specifications.

## Concurrent-work boundary — 17:26 UTC

The pre-cutover hash gate detected separate Dispatch fulfilled-TO implementation
being written after 17:24 UTC, following the complete 17:13:48 UTC release freeze.
No production restart occurred. The deployment boundary is the full immutable
worktree snapshot captured for this request. Record all newer file differences
and preserve them in the shared worktree. Require exact frozen-source/image
identity and unchanged production container/configuration preconditions. Do not
mix the newer in-progress TO implementation into this tested release.

## Mount verification correction — 17:28 UTC

The initial restart reached a healthy application, then the release verifier
rolled back because it compared Docker's mount arrays in their returned order.
Inspection of the restored app/worker proved every mount field and environment
value identical; Docker had reordered the arrays. Compare the complete mount
records sorted by destination. Preserve the original and rollback container
identities and require those identities before retrying the same tested image.
