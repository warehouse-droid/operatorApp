# Storage-retention evidence — 21 October 2026

Spec approval: not obtained (autonomous run). The user explicitly authorized
old-test cleanup, latest-five deployment retention, automatic cleanup after
tests, and protection of live containers/databases. They confirmed the database
backup transfer before cleanup. The source checkpoint was pushed as
`edc61458f0e0cb74f47d06221cd6f45e2e1a2c82` before deletion.

## Observed result

The two successful deletion passes reclaimed approximately **76.73 GiB**:
35.17 GiB from obsolete deployment copies and 41.56 GiB from old test artifacts.
Filesystem usage fell from 93% to 54%, leaving approximately 91 GiB available.
Both passes recorded identical production container IDs/start times before and
after deletion and successful health checks. No production Docker volume,
container, image, or network was deleted by retention.

Five complete deployment folders remain under `server/deployments`:

- `app-notification-roles-sounds-20261021`
- `transfer-yard-posting-20261021`
- `backorder-pending-po-20261021`
- `already-ordered-arrival-20261020`
- `regular-stock-input-20261020`

Older folders may contain tracked records, live Compose references, or
operational audits. Remaining sizes after cleanup: deployments 804 MiB,
deployment-backup metadata 116 MiB, and protected/recent test-area data 6.5 GiB.
Production database snapshots and active/recent work were deliberately retained.

The full backup remains at
`backups/production/mbbs-full-before-storage-cleanup-20261021T042003Z.dump`.
Its 801,118,832 bytes still hash to
`59abda52566f410db5f27e35f76a980d55820ec611a4b79d5e2c50e690cf4349`.

`operatorapp-copy-retention.timer` is enabled and active, with an hourly interval
and up to five minutes of jitter. A further service run completed successfully
with zero deletion actions. Its next scheduled run was 06:02:41 UTC.

Operational audit records are under
`/home/ubuntu/storage-cleanup/retention-audit/`:

- `20261021T045303365267Z-result.json`: deployment cleanup, 36,855 actions.
- `20261021T045550046307Z-result.json`: test cleanup, 79,433 actions.
- `20261021T045857798024Z-result.json`: subsequent successful run, zero actions.

The app was separately redeployed to `notification-roles-sounds-20261021` at
04:57:46 UTC, after both deletion passes completed at 04:57:14 UTC. Retention's
next preflight stopped while the app health status was `starting`; it succeeded
after the app became healthy. The database, worker, and Ollama identities stayed
unchanged. Concurrent test jobs belonging to other work were preserved.

## Reproducible checks

Run `bash docker/retention/check.sh` from the repository. The final fresh run
passed **17 tests**, killed **5/5 manual mutants**, and separately killed the
under-retention mutant using the ordering property test alone. The final suite
used shuffled order with seed `20261021`. Read-only configuration validation
passed for all **9 Compose services**, including bounded resources and every
per-run artifact mount. Shell syntax and Python AST parsing passed.

Tests used Python **3.12.15** from the digest-pinned image in `check.sh`, with
`mbbs-tests.slice`, 1 CPU, 512 MiB memory/swap, 128 PIDs, a 128 MiB temporary
filesystem, no network, a read-only root, init, and a disposable lifecycle label.
The exact test container was removed and checked in both `docker ps` and
`docker ps -a`. The installed CLI ran on host Python **3.14.4**. There are no new
Python packages; the implementation uses the standard library.

| Spec behavior | Verification |
| --- | --- |
| Latest five, ties, and 0–20 input copies | `test_latest_five_properties`, `test_tie_is_deterministic_and_invalid_count_rejected`; under-retention mutation killed |
| Protected files and outside data | `test_dry_run_then_delete_only_eligible`, `test_protected_descendant_and_sibling`; protection mutation killed |
| Symlinks and stale plans | `test_symlink_never_followed_and_root_rejected`, `test_directory_replacement_by_symlink_rejected`, `test_changed_plan_rejected_before_any_deletion`; root/fingerprint mutations killed |
| Recent/active runs | `test_recent_tree_preserved`, `test_active_run_lease_protects_long_running_job` |
| Success/failure/interruption teardown | `test_runner_success_and_failure_remove_artifacts`, `test_runner_term_cleans_and_preserves_exit`; artifact-leak mutation killed |
| Production/retained-copy guards | `test_live_preflight_requires_all_production_and_health`, `test_forged_plan_cannot_delete_retained_deployment`; real preflights and before/after checks |
| Audit preservation and copied-source classification | `test_operational_records_and_snapshots_are_preserved`, `test_copied_source_is_not_misclassified_as_audit_data`; reviewed manifest |
| Repeatable sweeps and root preservation | `test_idempotent_and_directory_age_preserved`, `test_periodic_sweep_preserves_empty_roots_and_removes_loose_artifacts`; later real run with zero actions |
| Scheduled bounded execution | Installed service/timer validation and successful real service executions |

Unit-run trace coverage was **137/164** executable lines in `retention.py` and
**105/187** in `host_retention.py`. These are limited unit measurements, not
100% changed-line or branch coverage. Child-process CLI paths and real
Docker/proc/systemd integration ran outside that trace. No standalone Python
type checker or linter was configured; AST/shell checks, the scoped diff check,
configuration validation, tests, and manual review were used. The whole app
suite was not run for this administrative change. The full Compose test runner
was configuration-checked; it was not used to rebuild/run the entire app suite.

## Failures and limits

Red runs exposed protected-file and changed-plan defects, the copied-source
classification issue, and accidental deletion of empty cleanup roots; the final
suite passed after fixes without relaxing assertions. Root-owned systemd
execution initially failed Git's ownership check before deletion; Git now uses
a command-scoped exception for this exact repository. A newly created concurrent
deployment invalidated an older plan, also before deletion; a fresh plan kept
the new latest five. An initial mount check found three services still using
the shared artifact directory; all now resolve the per-run directory.

SIGKILL cannot execute teardown. The hourly sweep recovers abandoned artifacts
after two hours of inactivity; active leases, processes, mounts, and running
test containers prevent sweeping in-use work. Custom harnesses must use the
documented wrapper and write to its artifact directory for immediate removal.
Legacy unwrapped output has the hourly fallback. Arbitrary privileged concurrent
filesystem mutation cannot be made transactional by this file-only cleanup;
fingerprints, no-follow descriptor traversal, and revalidation reduce that risk.
This evidence provides bounded confidence, not an absolute proof of safety.

Final code SHA-256 values:

- `retention.py`: `3c57aa7f9697abd848f3f414d0d1aa0e0d7b2db3913b4aecb050a25f45083e53`
- `host_retention.py`: `5781cf2961a27f00e77b02f31f2bb29c0794acab3877f760d2bda63c116544bf`
- `test_retention.py`: `577229550849542b5a995d91325b4148bc5f917e64c03200f5367a9201bdb2e8`

Installed implementation hashes matched the tested source. Detailed results,
source hashes, and final backup verification are in
`/home/ubuntu/storage-cleanup/runs/20261021-retention/`.
