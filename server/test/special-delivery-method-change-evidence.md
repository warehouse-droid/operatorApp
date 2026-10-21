# Special delivery method changes: verification

Status: deployed after the user's explicit “deploy” instruction. The additive alert migration is applied, production is healthy, and the live image contains the eight verified feature files. Production configuration and dependency containers are preserved. The earlier automatic approval rejection was resolved by the user's deployment instruction; the original pending-deployment record is retained as history.

Spec approval: not obtained (autonomous run). Tier 3 was used for order integrity, private team access and concurrent acknowledgement. No dependencies were added, and no commits were created.

## Behavior and evidence

| Behavior | Verification |
| --- | --- |
| Change vendor pickup to MBBS yard pickup after SO, PO and vendor PO reference are linked | `special-delivery-method-change.test.js`: linked-order snapshots, reference preservation, yard 3445 and Dispatch handoff |
| Notify SCM and Dispatch once on an actual method change | Persisted event metadata and per-team alert reads; historical/no-op/header/Backorder cases |
| Preserve alerts across reload and request completion | Receipt isolation test and browser reload test |
| Retries and failed saves create no duplicate or premature notices | Interrupted journal retry, PostgreSQL trigger failure and transaction rollback |
| Role, yard, revision and planning protections | Authenticated HTTP permissions and invalid ID properties; closed/planned/stale/foreign-yard checks |
| Acknowledgement remains independent by user/team and survives concurrency | HTTP and repository isolation; twenty concurrent HTTP acknowledgements save one receipt |
| Phone/desktop usability and connection/session failures | Playwright screenshots, queued dialog, polling, malformed payload, escaped text, access revocation and stale acknowledgement checks |

Focused suite: **24/24 passed**, zero failures. Reversed file execution: **24/24 passed**.

Special-workflow regression: **863/964 passed**, with **101 pre-existing failures**, exactly matching the recorded baseline; **zero new failures**. The existing failures include historical fixtures and artifact permissions, so the whole repository is not claimed to be green.

Changed executable lines: **246/246 executed** using c8 and Playwright coverage. Branch results are retained in `changed-coverage.json`; complete branch coverage of the existing large server/repository is not claimed.

Manual mutations: **6/6 killed**: lost team notice, notification on an unchanged method, cross-team receipt leakage, invalid ID acceptance (property suite independently), missing browser alert loader, and duplicate acknowledgement receipts.

Static checks: zero added type errors and zero added lint findings. The existing source imports have 21215 baseline type diagnostics; the same count remains. Seven changed JavaScript files passed syntax checks. Secret scanning passed.

Runtime: the prepared image passed bounded source-hash and server-import checks. The deployed source hashes, production health, protected alert routes and linked order references passed live verification. This task's test containers, disposable storage and test networks were removed; both `docker ps` and `docker ps -a` were verified. Another task's active isolated tests are recorded separately and were left intact.

The release overlays only the eight declared feature files on the current production image. One unrelated workspace comment in `src/server.js` is excluded from the release so the current live comment is preserved; executable code matches the tested source. The additive receipt migration does not alter order links, order lines, prices or existing PO references. The rollback image and Compose override are retained.

## Live rollout

SPREQ-000041 had already changed from vendor pickup to yard pickup at 3445 before deployment (original event 1059, 2026-10-09 15:16:30 UTC). Its PO is now planned. The first rollout restored the previous image because its verification incorrectly assumed this request remained editable. The check now verifies the existing planning/completion guard and preserved SO/PO/vendor reference; the planning lock was never removed. The second rollout passed product checks but restored the previous image because another task's active test containers triggered an overly broad cleanup assertion. Cleanup now checks this task's resources and records other active tests separately. Both failed attempts and their rollback logs are retained. The third rollout and final verification passed.

The user requested SCM and Dispatch alerts for this specific pickup change. Because it happened before the feature was deployed, a one-time catch-up operation appended notice event 1061 referencing original change event 1059. Both team feeds expose the notice. The operation verified that the original event, request, revision, case, order lines and handoff were unchanged, and a second execution reused the same notice rather than creating a duplicate. It did not re-save the delivery method or change the Dispatch plan. See `existing-change-notice.json`, `live.json`, `cleanup-release.json` and `deployment-status.json` in the task artifact directory.

## Reproduce

From the repository root, run `python3 server/tools/special-delivery-method-20261009/verify.py`. The runner uses the repository isolated Compose configuration, a pinned test image, `mbbs-tests.slice`, per-container memory/CPU/PID/tmpfs limits and teardown registered before startup. It records baseline, final validation and final evidence separately. The extra evidence step was added after fixing a reporting filename collision; the coverage artifact was regenerated from fresh tests. Browser fixture setup and new nullability diagnostics were corrected before passing final checks.

Node: v20.20.2. Tool versions: {"@playwright/test": "1.62.1", "c8": "12.0.0", "eslint": "10.8.0", "fast-check": "4.9.0", "typescript": "7.0.2"}. Tested source hash: `eddffdb7363ab2df1f29d9872c0eac02edb84b640699a594ca79add27c6e9da8`. File hashes are retained in `summary.json`; prepared deployment hashes are in `deployments/special-delivery-method-20261009/manifest.json`.

Operational rollout: `python3 server/tools/special-delivery-method-20261009/deploy.py apply`. The script rechecks the live image/configuration and active writes, applies the additive migration idempotently, recreates only the app service, verifies health/protected alert endpoints/SPREQ-000041 workflow guards, and restores the previous image on a failed release. Production schema and operational receipts are preserved during image rollback. `deploy.py verify` performs read-only verification of the deployed release.
