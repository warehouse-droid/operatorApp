# Consolidation Load pagination deployed — 2026-09-16

Deployed successfully at **02:20:30 UTC**. The app is healthy with zero restarts. Refresh the Operator app to load the five-order pagination and new date controls.

- Release: `mbbs-operator-app:consolidation-pagination-20260916-v1`
- Image: `sha256:328d6f4252c46f1e79cedbd232717c0e3515d8111926f94b4d8d3ddca5364100`
- Previous app image: `sha256:0ce822ac692745f914776588ecd77f58f5798cbe9047e9dc1b2694f4ad1102fb`
- Rollback tag: `mbbs-operator-app:rollback-consolidation-pagination-20260916`
- Successful cutover: **02:20:19–02:20:30 UTC**.

## Scope and verification

Only `public/operator.js`, `operator.css`, `operator.html`, `i18n.js` and `service-worker.js` changed in the image. A complete image-file comparison confirmed every other packaged file matches the previous release. No migrations or backend changes were deployed.

The packaged candidate passed **21 unit/contract tests and 7 browser tests**, including desktop and touch pagination, saved selections, date filtering/entry, photos and receiving regressions. Source hashes match the verified implementation manifest.

Only the app service was recreated. Environment values, mounts, command, user and ports were preserved. Webhook worker, database and Ollama container identities and start times were unchanged. The worker intentionally remains on the previous image, whose backend is byte-identical to this UI release.

Local and public health returned HTTP 200 with `ok: true`. All **10 local/public asset probes** matched the packaged files. Public HTML normalization removes only the previously established Cloudflare analytics injection; JavaScript, CSS and service-worker responses match exact hashes. The anonymous consolidation endpoint returned HTTP 401. Posting, photo-upload and webhook activity were checked before cutover; none was active.

No live receipt, fulfillment, load or photo was created as a deployment test.

## Probe correction

The first packaged browser run could not save screenshots because its output directory belonged to root. Assigning that isolated directory to the browser container's user allowed all seven tests to pass. No application code changed.

The first cutover at 02:18:21 UTC passed app health and asset checks, then rolled back when Cloudflare returned HTTP 403 to the default Python public-health request. The restored previous release showed the same response, while the identical request with browser headers returned HTTP 200 and `ok: true`. The verifier now uses the same browser headers as its asset probes and retains the HTTP/body assertions. The unchanged, tested image was then deployed successfully. First-attempt records are preserved under `attempt-1/`.

## Records and rollback

Private release directory: `/home/ubuntu/operatorapp-deploy-backups/consolidation-pagination-20260916/`.

It contains the source/image manifest, prior container and Compose configuration snapshots, extracted candidate assets, test results, startup logs, active-work checks, live verification and final deployment result. The rollback image and `compose.rollback.yml` are retained. Apply that override last over the Compose paths recorded in `containers.before.private.json`, using `up -d --no-deps --no-build --pull never app`. Do not recreate the worker or restore database data for this UI rollback.

The release helper is `tools/consolidation-pagination-deploy.py`; `verify` repeats read-only live asset and health checks. Preparation/application intentionally require the captured previous release and source hashes.
