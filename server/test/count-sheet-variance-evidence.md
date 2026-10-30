# Count-sheet VAR correction — 2026-10-21

The user's latest formula supersedes the initial adjustment release:
`VAR = Counted − Actual on hand + Adjusting`.
The existing deployment authorization covers this correction; implementation
and verification proceeded autonomously. The original release evidence remains
historical in [count-sheet-adjustments-evidence.md](count-sheet-adjustments-evidence.md).

The correction covers browser previews, persisted confirmations and adjustments,
comparison reconstruction, and English/Chinese help. Migration 303 recalculates
known comparisons while preserving saved counts, signed adjustments, snapshots,
sheet assignments and activity. Applied migration 302 remains unchanged.

Before implementation, the revised focused suite had 7 expected failures and
10 passes: browser and database comparisons still used the prior formula, and
the new migration was absent. After correction, the exact candidate image passed:

| Verification | Result |
| --- | --- |
| Inventory/count-sheet database, HTTP and Chromium regressions | 109 passed, no failures/skips |
| Reordered focused suite | 17 passed |
| Changed executable line coverage against repository HEAD | 71/71 covered |
| Deliberate regressions caught | 5/5 |
| Signed decimal property against the reverted-formula mutation | Caught |
| Syntax, scoped ESLint, validator TypeScript and secret scan | Passed |
| Complete candidate runtime hashes | 1,436 matched |

The migration test checks positive and negative existing adjustments, unknown
actual stock, unchanged count contents and snapshots, repeat execution, and
transaction rollback. Existing reset/re-open and concurrency regressions passed.
Mutation checks cover reverting the formula, retaining discarded counts, stale
revision acceptance, retaining submission time, and losing adjustments on
re-confirmation. Property checks use 30 generated decimal quantities.

Validation used the repository's bounded disposable runner and standard isolated
Compose configuration. Both runs removed their test containers, databases,
volumes, networks, browser downloads, dependencies, coverage and logs. Production
health and both Docker container listings passed after teardown.

Candidate image ID:
`sha256:387b6d52511290b5a682a0740e3a40c7383bfd99e7d0f672fc8d0d0c630fc683`.
Ordered runtime/test source hash:
`c7d096e2caef5ceb52183004e35de92186b71579c6a97b72b201aea6a393f7de`.
Runtime tree hash:
`35af8b6390c692853111b1f6ea47b165ec29d7928c7dccb563f89918defc0cf8`.

Reproduction: run `bash server/tools/count-sheet-adjustments-isolated.sh` from
the repository root. Exact-image validation additionally sets
`COUNT_ADJUSTMENTS_RUNTIME_IMAGE` and `COUNT_ADJUSTMENTS_RELEASE_DIR` and runs
`node tools/count-sheet-adjustments-candidate.mjs` through that runner. Use a
fresh release directory containing only source/manifest metadata, never one
containing production database backups. The runtime and dependency versions
are retained in the deployment validation record; dependencies did not change.

Validation is scoped to the inventory feature and this migration. No live count
reset or NetSuite write was performed, and the unrelated repository-wide MBT
suite was not run. There were no git checkpoint commits.

## Authorized deployment

Deployed at 23:47 UTC on 2026-10-21 using
`mbbs-operator-app:count-sheet-variance-20261021`. Migration 303 preserved all
49 count rows and their adjustments, snapshots, headers, assignments and events;
before/after fingerprints match with only variance excluded. There are zero
stored known comparisons inconsistent with the corrected formula.

Local and public health and `/control/count-sheets` returned 200. All three
changed public asset hashes matched the validated image. Unauthenticated
adjust/reset/reopen requests returned 401. The application is healthy, runtime
settings and dependent containers are unchanged, and both `docker ps` and
`docker ps -a` contain only the four production containers. The disposable run
directory is empty. Cutover through verification took 18.582 seconds.

The rollback image preserves the prior application and the rollback procedure
restores its variance convention without discarding counts or adjustments.
Schema/count-sheet backups and deployment audit records are retained under
`server/deployments/count-sheet-variance-20261021/`.
Read-only verification is available with
`PYTHONDONTWRITEBYTECODE=1 python3 server/tools/count-sheet-variance-release.py verify`.
