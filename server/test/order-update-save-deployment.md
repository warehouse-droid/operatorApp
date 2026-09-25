# Dispatch order-update save fix deployment

Status: deployed successfully on September 18, 2026. Cutover began at
02:40:36 UTC; the app and worker were verified ready at 02:40:56 UTC.

The user explicitly requested deployment after accepting the measured timing
differences documented in [the verification report](order-update-save-evidence.md).

The release image is `mbbs-operator-app:order-update-save-20260918`, image ID
`sha256:7c090775306ec5c6af811fa136cab9dd743e5a3335c1e3a833e6e6c783a0715d`.
It starts with the deployed app image and changes only the eleven files in
`tools/order-update-save-files.mjs`. The task's `server.js` patch was applied
with zero fuzz to the deployed file, preserving unrelated live code and
excluding unrelated workspace changes. Its five shifted hunks all applied
with the same six-line offset.

The webhook worker imports `server.js`, so it receives the deployed app's
compatible backend module set plus this fix. Its entry point, webhook queue
code, package manifest and lockfile match its previous version. The app and
worker retain their distinct commands, environment, mounts and ports. The
database and Ollama containers are not replaced.

The migration step applies exactly `205_dispatch_plan_maintenance.sql` in one
transaction after schema and Dispatch-table backups. It does not apply the
unrelated pending migration 203. Cutover checks for active Dispatch editors,
NetSuite postings and running webhooks before and after migration. Rollback
images preserve each service's previous image separately; rollback retains
migration 205 and pending maintenance work.

The original verification remains unchanged. The exact package was checked
again before deployment:

| Check | Result |
|---|---|
| Focused save/order regressions | All 50 pass, including all seven requested action categories |
| Full application comparison | Same 11/523 failing files on live baseline and candidate; zero new named failures |
| Other Dispatch comparison | Same 31/206 failing files on both; zero new named failures |
| Chromium and WebKit | Every save returns 200; delayed/lost-response retry preserves the committed revision; Undo depth remains 11 |
| Browser action feedback | Maximum 98.0 ms in Chromium and 217.5 ms in WebKit, within the 500 ms gate |
| Actual image startup | Both app and worker start against an isolated database migrated by the image itself |

The packaged full-suite baseline differs from the earlier workspace baseline
because the package preserves the live app's unrelated code. Its matched
comparison records those existing failures; the suite is not represented as
entirely green. The previously accepted performance measurements remain in
the original evidence report.

The database schema and Dispatch-table backups were created and their archive
contents verified before migration. Migration 205 applied successfully. Both
services are healthy with zero restarts, and monitoring after startup found
no fatal or Dispatch-maintenance errors. Service configuration was preserved;
the database and Ollama container identities and start times are unchanged.

Read-only production checks verified all 115 saved-plan revision/digest pairs
before and after deployment. The maintenance queue has zero pending, due or
failed entries. The public Dispatch page and versioned script both return 200
and match the deployed hashes; the known Cloudflare analytics injection was
removed only for the HTML hash comparison. No synthetic test saves or manual
production-plan edits were performed.

The deployment commands are persisted in `tools/order-update-save-deploy.py`
(`prepare`, `check`, `preflight`, `apply`, `verify`). Package tests use
`tools/order-update-save-release-test.sh` with separate source and artifact
directories; `tools/order-update-save-image-smoke.py` starts both image entry
points on an internal test network. Production verification uses the read-only
`tools/order-update-save-live.mjs`.

To reproduce the complete package checks against the preserved baseline and
candidate, run:

```sh
sudo -n bash server/tools/order-update-save-release-checks.sh
```

Private container configuration, rollback Compose overrides, backups, patch,
manifest and deployment logs are kept in
`server/test-artifacts/order-update-save/deployment/`.
