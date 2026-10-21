# Whole worktree deployment — 25 September 2026

Deployed the full application worktree snapshot from **2026-09-25T20:10:05.523935+00:00**.
Production verification completed at **2026-09-25T20:31:29.174094+00:00**. Both the app and
webhook worker run `mbbs-operator-app:whole-worktree-20260925-v1` (`sha256:1570a06d52cc4cd591f598034933fcc1bfe452d6e7bf22d4b68fe7e43c4d3613`).
All **1078 runtime files match in each service**, with
23 changes from the prior application. Source manifest
SHA-256: `dc3d97789e26f91fb076f7219b79b87025aeca39caaa7be6e256f2386284702b`. Git base: `3de46cd5953ac57ded6833605060280e355aaa5f` plus the
recorded worktree changes. This deployment did not create a new Git commit.

The previously pending Dispatch executed-order source review, persistent
acknowledgements, blank-address protection, and Special Order quantity queue
refactor are live. Verified source updates permit further planning without
requiring acknowledgement first; manual edits to executed route history remain
protected. The earlier SCM Aggregate alert, exact submission timestamps,
confirmation date editing, and Operator priority fix remain present.

## Release evidence

| Check | Result |
| --- | --- |
| Full MBT suite | 604 files; 3268 tests, 3241 passed, 26 pre-existing failures, 1 skipped, 0 cancelled |
| New broad-suite failures | 0; every failed file was replayed against captured production source |
| Focused Dispatch / randomized Dispatch | 107 / 107 passed |
| Special Order HTTP checks in required disposable DB | 7/7 passed |
| New feature modules | 473/473 lines, 44/44 functions, 367/462 branches executed |
| Deliberate bug detection | 7/7 detected; property tests independently detected all 5 applicable mutants |
| Static comparison | 0 new lint/type diagnostics; 2163 existing lint diagnostics and 282 TypeScript output lines |
| Actual production image rehearsal | App health 200, worker started, repeated migration run passed |
| Priority / rollback rehearsal | Operator work completed while worker background work held a shared slot; queue reservations cleaned; prior app and worker started against the upgraded schema |
| Production verification | Local/public health 200, 9 asset hashes matched at each endpoint, anonymous API access 401, zero restarts |
| Settings and services | App/worker configuration preserved; database and Ollama were not restarted |
| Dependencies and secrets | No dependency changes; changed-runtime credential-pattern scan found 0 hits |

Migration `212_dispatch_executed_order_reviews.sql` was applied before the new app started.
The additive review table can remain if application images are rolled back.
No live NetSuite test documents were created. A private custom-format database
backup was validated with `pg_restore --list`: 396094684 bytes,
3515 TOC lines, SHA-256 `68e8322d6bd834b4653f221add1c554f5a8bbbc0ea0767917c6f444aca94b3c2`.
Previous app and worker image IDs and rollback Compose overrides are retained.
Read-only live NetSuite probes succeeded from both services. The app's Operator
probe spent 10.75 ms in the shared queue and
1439.1 ms overall; the worker background probe spent
9.96 ms in the queue and
979.74 ms overall. These were reads of an
existing IF, not measurements of a newly submitted customer pickup.

## Existing failures and limits

The broad suite is not wholly green. These failures were reproduced against the
previous production source, with the same tests and isolated runner:

- /app/test/mbt/integration/local-load-performance.test.js
- /app/test/mbt/integration/operator-background-photos.test.js
- /app/test/mbt/integration/operator-display-settings.test.js
- Control and Admin request the cache-busted thumbnail hydration client
- F06/F16: schema-101 upgrade preserves representative legacy records and is migration-runner idempotent
- F15: all MBT routes render one accessible controlled shell with an explicit controller
- P3.11: the deployment inventory exactly covers every on-disk MBT-era migration
- P3.12: browser specs share one worker-owned database-pool lifecycle
- S11: the guarded client ships in a new atomic Driver shell generation
- S7: Operator cache revision ships the live-policy client once; later toggles are server-only
- a failed staging download leaves the active and non-Driver caches byte-for-byte unchanged
- a fresh Driver shell version evicts older copy-enabled cached assets
- a fresh Driver worker reloads every v41 shell asset and initializes only its scoped sentinel
- a successful repair replaces only the complete Driver shell and preserves offline data sentinels
- duplicate concurrent SO and PO skips each commit once and preserve role-owned order kind
- gate disable wins before a waiting skip transaction without advancing the request
- new enquiry rejects a missing line rate and calculates each line discount independently
- normal stock draft preserves every line field and consumes the draft only on success
- operator cache assets advance with the cycle-count pagination release
- page confirmation has a duplicate-click guard and ships in a fresh Operator cache
- quantity endpoints enforce login, SCM-only approval, Sales role, yard scope and workflow gate
- real creation claim and test skip cannot both acquire the same request revision
- simultaneous SCM approvals commit once and Sales cannot bypass the review through test skips
- skip HTTP routes require authentication, correct role, gate and Sales yard access
- the reset ships as a new atomic shell generation without forcing a protocol-version cutover
- the updated override policy is atomically included in the Driver PWA shell

The Special Order HTTP files require a database ending in `mbt_verify`; the full
suite uses per-file `mbt_test` clones. Their seven scenarios all passed when rerun
on their required isolated database. The stock-return failure depends on the
seeded return-reason cache aging past ten minutes during the full run: a harmless
metadata GET is recorded by its fixture as an unexpected external request. Five
fresh-cache repetitions passed on each source tree; explicitly aging the cache
reproduced the same failure on both versions. This is retained as known test debt.

Two supplemental legacy harnesses also fail identically on both source trees:
Driver cannot isolate the duplicate-completion source block; Operator expects an
older two-column return layout. Neither is a new release regression. Assertions
were not weakened or skipped to obtain a passing release decision.

Initial browser checks could not write their screenshots/reports because of
test-container artifact permissions and a missing output directory. Correcting
the runner setup produced 107 passing focused tests. An initial combined
coverage/mutation invocation contaminated the disposable mutation baseline with
coverage fixtures; mutation was rerun before coverage in a fresh database and
detected all seven bugs. Production source was unchanged during these checks.

Coverage measures the four new modules, not every changed legacy/browser line.
Those paths have functional, contract, browser and concurrency checks. Existing
type/lint debt remains. Tests use local mirrors and controlled network boundaries;
they do not constitute a production-load benchmark or a live accounting write.
User deployment authorization was explicit; the detailed deployment specification
was not separately reviewed (autonomous execution).

## Reproduction and retained records

Release tools are `tools/worktree-release-20260925.py`,
`tools/worktree-release-test-20260925.sh`,
`tools/worktree-release-feature-checks-20260925.sh`,
`tools/worktree-release-smoke-20260925.py` and
`tools/worktree-release-evidence-20260925.py`. Existing test dependencies were
provided by `field-sales-check-2941306:latest` (Node 20.20.2).

The frozen source, production baseline, full file hashes, build/test logs,
per-file failure replay logs, screenshots, migration/backup details, image
rollback definitions and live verification are retained privately in
`server/test-artifacts/whole-worktree-deployment-20260925/`.
Backup files, credentials, operational data and generated test artifacts are
excluded from the application image; no application feature remains excluded.

Recheck the frozen suite from `server/`:

```sh
sudo -n env WORKTREE_RELEASE_CHECK=full-recheck bash tools/worktree-release-test-20260925.sh npm test
bash tools/worktree-release-feature-checks-20260925.sh
python3 tools/worktree-release-smoke-20260925.py
python3 tools/worktree-release-evidence-20260925.py supplemental
python3 tools/worktree-release-20260925.py verify
python3 tools/worktree-release-20260925.py live-probe
```
