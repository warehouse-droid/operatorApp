# Independent split dates: SOA08404-S2

2026-09-16. Tier 3; spec approval not obtained (autonomous run).
Acceptance criteria and failure model: [spec](dispatch-split-date-conflict-spec.md).

## Diagnosis and change

Failed recovery snapshots 17496 and 17497 belong to September 17 plan 329.
Snapshot 17497 retains all 22 orders, including SOA08404-S2 on T4 / BC71838 /
Load 1, and records `DISPATCH_ORDER_ALREADY_PLANNED` against September 10 plan 322.
The earlier plan's assignment projection has SOA08404-S1 as a direct assignment
and SOA08404 as its `split_parent_alias`. It has no SOA08404-S2 assignment.

The date validator treated that alias as an assignment of the whole parent.
It now distinguishes parent aliases from actual whole-order assignments when
checking a split child. Exact-reference checks retain all assignment kinds, so
planning the whole parent remains blocked by an assigned child. Direct/grouped
parent assignments and unknown assignment kinds still protect their children.

Only `src/server.js` changes at runtime. Locks, revision handling, assignment
projection construction, save-recovery semantics, and global visibility flags
are unchanged. The prior visibility repair was separately recorded by audit 21448.

Baseline source SHA-256:
`b358d80f27da9c6ebab33e14b9d54a297f40219adf50d089aed91fadb5fc6d8e`.
Corrected source SHA-256:
`a95502dbd9cad624dbe3cf555ba790dc7f660d421e2f1afdbc9aaa10aff28c88`.

## Reproduction and focused verification

- Original implementation: unit regressions fail 4/8. The corrected implementation passes 8/8.
- Authenticated HTTP regression: both classic and v2 saves accept S2 on a later date, preserve S1's prior route, and create the exact S2 assignment. Negative HTTP cases retain the rejected draft without advancing the active revision.
- Final focused run: 12/12 pass; isolated adjacent concurrency/recovery run: 8/8 pass.
- Seeded fast-check properties: 150 cases, seed 20260916, covering SO/TO, casing, groups, sibling independence, exact duplicates, whole parents, and parent aliases.
- Five deliberate mutations are killed by the full unit tests and independently by the properties: sibling overblocking, missing parent protection, grouped-parent bypass, exact-split bypass, and case regression.
- Actual server execution covers all four changed executable statements (lines 3200, 3204, 3205, 3213). Whole-file coverage is 17.25%; only the changed statements are claimed as fully covered.
- Snapshot 17497 passes the corrected date validator with `conflicts=[]`. Replay uses a repeatable-read, read-only production transaction and verifies the saved snapshot digest is unchanged. It does not apply the draft.

Initial negative HTTP assertions expected 409; the established API instead
returns 202 / `DISPATCH_PLAN_RECOVERY_SAVED` with `applied=false` and the nested
date-validation error. Assertions were corrected to require that contract,
preserved revision, and retained recovery. A later fixture failure identified a
missing registered truck; the fixture now seeds a valid isolated truck. Neither
change weakens the date checks. A test-only shadowed variable was renamed for lint.

Both complete `npm test` runs executed all 505 MBT files. Each fails only the
pre-existing `P3.12: browser specs share one worker-owned database-pool lifecycle`
contract in `p3-gauntlet-contract.test.js`; there are no new test failures.
TypeScript retains the same 233 existing diagnostics. ESLint retains the same
existing `getSmartScmNetSuitePoReviewLoad` undefined-symbol diagnostic in
`src/server.js`; the new test/helper JavaScript introduces no diagnostics.
The secret scan and `git diff --check` pass. `final-gates.log` records the
completed-suite comparison and matching hashes after all test corrections.

The original deployed image also reproduces the exact failure on snapshot
17497 in a read-only replay: S2 incorrectly conflicts with plan 322 / September
10. The candidate replay returns no conflicts with the same snapshot digest.

## Reproduction commands and artifacts

From the repository root, with Docker available:

```sh
bash server/tools/dispatch-split-date-conflict-gauntlet.sh
```

The runner uses disposable PostgreSQL databases on internal Docker networks and
the retained `mbbs-retired-confirm-test:20260914` image (Node v20.20.2). It restores
the original validator in a separate mount using the checked-in reverse patch;
it does not edit the working implementation to test the baseline or mutants.
No dependencies were added. Property tests can run independently through
`node --test --test-name-pattern=properties: test/dispatch/unit/dispatch-split-date-conflict.test.js`
inside the isolated runner.

Logs, coverage JSON, source hashes, and mutation results are under
`server/test-artifacts/split-date-conflict/` (ignored generated artifacts).
`SPLIT_DATE_REUSE_FULL=1` reuses the full-suite runs for the unchanged implementation;
the deployment gate separately requires both completed 505-file suite summaries.

Deployment preparation and application are separately guarded:

```sh
python3 server/tools/dispatch-split-date-conflict-deploy.py prepare
python3 server/tools/dispatch-split-date-conflict-deploy.py apply
```

The prepared image differs from the current image in `src/server.js` only and
passed isolated migration/startup/health checks. Deployment metadata and rollback
Compose overrides are retained privately under
`backups/dispatch-split-date-conflict-20260916/`. Only the app is replaced; the
worker and dependencies must retain their container identities and start times.
The verifier checks environment, mounts, ports, source hash, health, and the exact
failed snapshot against the installed image.

No browser layout changed; authenticated HTTP saves provide the interaction
coverage. No new dependency/license audit or production draft write is needed.
Whole-file mutation and exhaustive state-space verification are not claimed.

## Deployment result

Deployed `mbbs-operator-app:dispatch-split-date-conflict-20260916-v1`, image
`sha256:d4b0b2221d2157332aa72af1e376268fc2a0065f3e48ac066a8f8d857b3cc55d`.
The installed server hash matches the tested source; health returns `ok=true`.
Environment, mounts, and ports are preserved; worker and dependency containers
are unchanged. The installed-image read-only replay of snapshot 17497 returns
`conflicts=[]`, `orderCount=22`, and `snapshotUnchanged=true`. The rejected draft
remains available for the user to save normally; it was not silently applied.
