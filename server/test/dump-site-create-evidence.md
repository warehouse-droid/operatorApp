# Dump-site code fix — evidence, 2026-10-23

Spec approval: not obtained (autonomous run). Tier 2 internal configuration bug fix; acceptance criteria are in `dump-site-create-spec.md`. No dependencies, migrations, or commits were added.

The initial disposable run reproduced all four unit/property failures and the actual browser error for code `3445`: expected “Dump site created.”, received “The dump-site row is invalid.” The same browser flow now passes without API mocks.

| Acceptance criterion | Evidence |
| --- | --- |
| Create and edit `3445`, retaining accepted items and five opening days | `mbt/integration/dump-site-create-browser.test.js`; persisted database assertions |
| Normalize numeric and hyphenated identities; activate/delete/import consistently | Browser lifecycle and CSV assertions; `mbt/unit/dump-site-code.test.js`, including 120 generated round-trip cases, seed 3445 |
| Explain invalid codes/hours, retain entries, allow correction | Browser asserts clear errors, no invalid POST, retained name, successful corrected submission; hostile/oversize/blank code unit cases |
| Preserve permissions, revisions, required acceptance, atomicity and other configuration | Existing validation-boundary, master-service, import, item-catalog, guarded-deletion, item-settings, concurrency and rate-card suites in the persisted gauntlet |

Final exact-candidate run: 151/151 tests passed across 17 files; reverse-order subset 27/27 across 5 files. No failures or source drift.
Changed JavaScript coverage: 26/26 lines and 12/12 measured branches. All 4/4 manual mutants were killed (reject numeric codes, reject hyphens, inconsistent activation identity, skip browser hours validation).
Static checks: two JavaScript files pass syntax checks, zero new lint/type errors, zero baseline type errors, zero diff-secret findings. `git diff --check` passes. Existing lint complexity constraints were retained.

Reproduce from the repository root (uses the standard bounded disposable runner and automatic teardown):

```sh
DISPATCH_SOURCE_SKIP_BUILD=1 \
DISPATCH_SOURCE_RUNTIME="$PWD/server/deployments/dump-site-create-20261023/candidate" \
DISPATCH_SOURCE_MIGRATIONS="$PWD/server/deployments/dump-site-create-20261023/candidate/migrations" \
bash docker/run-dump-site-create-checks.sh
```

Toolchain: node v20.20.2, typescript 7.0.2, eslint 10.8.0, c8 12.0.0, fast-check 4.9.0, playwright 1.62.1, pg 8.21.0.

Scope limits: this run covers the affected configuration domain, not the full application suite. The reverse-order rerun is the five-file targeted subset. No dependency audit was needed because dependency files are unchanged. No new network, filesystem, subprocess, or environment capabilities were added to runtime code. No test site was created in production.

Deployed 2026-10-23T16:08:04Z as `mbbs-operator-app:dump-site-create-20261023` (`sha256:49479f13468fc35cf2f3f28e7918db812f98fd00e3cd7c0fad09f5fc6e6fc45f`). The release was rebased over the newer `operator-shared-pack-balance-20261023` image before validation, with a three-file overlay and no merge conflicts. Live file hashes, configuration page/help/asset version, protected API authorization, and health were verified; application configuration and other services were preserved.

Source SHA-256 values:

- `src/mbt/local-master-data-service.js`: `7e695c963727d978b89973a0ee6b1e08d30a5399a2c085123ace67975db1aa13`
- `public/mbt-shell.js`: `4cb0fe23c512253756a2daae7073dd7506ec76e66b2e17aa77e35af19b3d3dd4`
- `public/mbt-config.html`: `86bdd58399d124b6735a1ea0d839060fd13d45609439f569a0863745eb5124f5`

All test runs used `mbbs-tests.slice` with bounded resources and registered teardown. Containers, disposable databases/storage, networks and generated test artifacts/logs were removed after each run. Final `docker ps` and `docker ps -a` showed only the four production containers; no disposable volumes/networks or artifact run directories remained. Only this concise evidence and release/rollback audit records are retained.
