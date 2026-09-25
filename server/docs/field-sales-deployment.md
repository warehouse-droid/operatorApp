# Field Sales deployment

**Deployed and enabled:** [https://test.mbbsoperation.com/field-sales/](https://test.mbbsoperation.com/field-sales/). Cutover began at **2026-09-18 23:31:54 UTC**; the new application passed local and public verification at **23:32:06 UTC**. Automatic City refresh is enabled. NetSuite quote posting remains disabled.

Deployment authorized by the user's “deploy” instruction on 2026-09-18. The detailed deployment procedure is executed autonomously under that authorization. No additional account access or quote-posting approval is inferred.

The release starts from the current production application image and adds the verified Field Sales files, exact scoped integration patches, migration 210 and the pinned PDFKit dependency graph. Existing dependency versions, other runtime files, application configuration, webhook worker, PostgreSQL and Ollama are preserved. Existing package scripts stay as deployed.

Before cutover, verify the original implementation fingerprint, the packaged module's tests/browser flows, production image startup and migration on an isolated database, and exact image-file hashes. Retain a rollback image and a validated database backup. Apply only migration 210 transactionally with bounded lock/statement timeouts. Recreate only the application after confirming active postings/editors are idle. Restore the previous image automatically if health or live verification fails; retain additive tables and any saved Field Sales history.

After cutover, verify local/public health, module assets, anonymous API denial, tables and settings. Enable Field Sales and automatic public City imports, refresh the local catalog, and verify initial planning data. Live NetSuite quote posting remains disabled until the dedicated RESTlet and account mappings are configured and sandbox validation is complete.

Implementation evidence remains in [field-sales-evidence.md](field-sales-evidence.md). Deployment artifacts and private rollback/configuration/backups are stored in `server/test-artifacts/field-sales/deployment/`; do not publish that directory. It is Git-ignored, with directory mode 0700 and private configuration mode 0600.

## Release identity and verification

- Deployed image: `mbbs-operator-app:field-sales-20260918-v1`.
- Image ID: `sha256:eccf5cc3f60d32efa24651b2011e513f58c41fe90af006b27d0ab1a72b67db1f`.
- Previous image / rollback ID: `sha256:b766c17d0c4cb41b9463cf31c9fbe846ea9b93ee68e6eb6f706dcaf164f42bb2`.
- Retained rollback tag: `mbbs-operator-app:rollback-field-sales-20260918-v1`.
- Original verified implementation hash: `fbf6fe8c0153c74eb00a05284df732c7a4d34281a2587d9ae007eaa096c5ac63`.
- All **34 release files** matched the image and running app. Shared source patches applied with zero fuzz. Unrelated live asset versions were preserved.
- Packaged checks: **65 tests passed, zero failed or skipped; five browser scenarios passed**, migration and activation rehearsed, actual production image startup passed with four entrypoints and five authenticated endpoints checked. Test credentials/database/network were isolated from production.
- Public and local checks: health and module page returned 200, nine served asset hashes matched at each origin, and all four anonymous Field Sales API requests returned 401.
- Migration 210 applied successfully. All **18 Field Sales tables** exist. Existing service configuration was preserved, and the webhook worker, PostgreSQL and Ollama container identities/start times remained unchanged.

The first build failed before any cutover because the accumulated live-image layers exceeded BuildKit's mount-option limit. Exporting/importing the exact base filesystem removed that limit; **943 existing runtime files** were hash-verified before adding Field Sales. Image environment, entrypoint, command, user, working directory, exposed port and health check were retained. No original runtime dependency version changed; PDFKit's two previously shared optional/development dependencies became runtime dependencies at their existing pinned versions. The first failure log is retained.

The production backup is **307,209,445 bytes**, SHA-256 `2a2325d2d2933f07c3e6a22b09d691f6daa84e6e3b47172fc450aa265d6edfbb`. Its archive inventory and full contents were read successfully with `pg_restore` without restoring or changing data. The backup and rollback image remain available; no rollback was needed.

## Activation and remaining configuration

All four initial automatic imports completed without errors, confirmed at **23:40:52 UTC**:

| Source | Records read |
| --- | ---: |
| Community Planning / Open | 5,724 |
| Postal areas | 26,613 |
| Active permits | 205,537 |
| Municipal addresses | 525,439 |

The planning records represent **2,154 applications**, all **25 wards / four districts**. Source records can represent multiple addresses or revisions; these counts are not unique-jobsite counts. Daily planning/postal/permit refresh and weekly address refresh are enabled. Read-only verification also exercised the actual default prospect list and map queries against the live imported data.

The local catalog contains **1,727 MBBS items**. There are currently no valid configured MBT item mappings, and `FIELD_SALES_RESTLET_URL` is absent. Quote drafts/PDFs are available; MBT catalog entries, authoritative NetSuite pricing and live estimate publication require the account setup in [field-sales.md](field-sales.md). No NetSuite records were created during deployment. The existing browser/server Maps keys are configured and the shared Maps mode is `normal`; no paid routing request was used as a deployment probe.

Activation was recorded with actor `deployment:field-sales-20260918`; no existing user was impersonated and no production test account or quote was created. Administrators can access the module immediately and grant the `field_sales` authority to reps.

## Commands and retained artifacts

The release commands are persisted in `tools/field-sales-deploy.py`. A new release follows `capture`, `prepare`, `build`, the packaged checks, `preflight`, `apply`, `activate`, and `verify`. Existing captured releases are protected from accidental overwrite.

```sh
bash server/tools/field-sales-release-check.sh
python3 server/tools/field-sales-deploy.py verify
```

The packaged checker used the retained `field-sales-check-2941306` test image built from the checked-in `Dockerfile.test` and locked dependencies. If rebuilding the test tools elsewhere, build that Dockerfile's `test-e2e` target and set `FIELD_SALES_TEST_IMAGE` to the resulting tag.

`manifest.json`, `release.patch`, `flattened-base.json`, `candidate-checks.json`, `checks/`, `backup.json`, `migration.log`, `cutover.log`, `activation.json`, `runtime-health.json`, `deployment-tools.json`, and `deployment-result.json` retain the release evidence. `compose.rollback.yml` selects the exact previous image; compose arguments must include the captured configuration-file chain and recreate only `app`. Rollback retains migration 210 and saved Field Sales history.

## 2026-09-19 planner follow-up

Ward names, automatic list filtering to the visible map and bulk route selection were deployed at 00:12 UTC. This four-asset release overlays the application image that was live at preparation and preserves unrelated intervening work. See [the follow-up verification and deployment evidence](field-sales-map-evidence.md) for the exact image, source hashes, 69 tests, 12 browser scenarios and 14 live checks. No activation or database migration was repeated.

## 2026-09-19 recent-leads follow-up

The 12-month default, structured construction-work filter, qualifying source dates and milestone/source correction were deployed at **00:41 UTC**. [Recent-leads evidence](field-sales-recent-evidence.md) records 80 passing tests, 15 browser scenarios, five mutation kills, exact packaged-image checks and 12 public/local checks. Image `mbbs-operator-app:field-sales-recent-20260919-v3` overlays five files on the preceding map release; settings, imports, history and other services are preserved. No migration or activation was repeated. Read-only verification found 8,879 recent recommended jobsites and 170 recent complete-application jobsites citywide in the current imported snapshot.

## 2026-09-19 Visiting follow-up

Direct Record Visit, Edit Stop, Navigate and Quote actions and the always-open Visiting workflow were deployed at **00:55 UTC**. Routes have no Start/Pause/Finish controls, and the selected route survives reloads. [Visiting evidence](field-sales-visiting.md) records 80 passing tests, nine browser scenarios, lint and 12 live checks. Image `mbbs-operator-app:field-sales-visiting-20260919-v4` changes only three frontend assets; no configuration or database change was made.
