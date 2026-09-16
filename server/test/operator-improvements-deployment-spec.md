# Operator improvements deployment — 2026-09-16

The user explicitly requested deployment after verification of the consolidation fix. Deploy the combined, tested IF/IR timing, deferred photo upload, compact posting notice, completed receiving exclusion/search reset and grouped Consolidation Load changes.

## Acceptance

- Overlay exactly the 19 runtime files in the chained `operator-posting-latency` and `consolidation-group-planning` manifests onto the current SN1400333 release. Require matching source hashes, preserved baseline file hashes and no new failures in the recorded full suite.
- Compare the complete packaged runtime, assets, migrations and package files with the tested workspace. Run targeted tests against extracted candidate files and start the production image on an isolated database without an external network.
- Preserve service environment, mounts, commands, ports and users. Retain the current image and Compose rollback definition. Recreate only the app and webhook worker when no posting or webhook job is executing.
- Apply only migration `201_operator_posting_photo_uploads.sql` in a transaction with bounded lock/statement timeouts. It creates the photo queue and adds a nullable batch field; it updates no existing business rows. Retain validated custom-format backups of the schema and affected existing table/migration registry.
- An application rollback keeps the additive schema and any new queued photos. Do not drop the queue, restore business data or repeat NetSuite transactions as a deployment check.
- Verify app health, worker startup, source identity, unchanged dependent containers, local/public asset hashes, Sep-16 consolidation selections and SN1400333's receiving exclusion using the actual deployed modules in a read-only transaction.
- Record the exact release, migration, test results, operational checks and rollback paths. No new live receipt, fulfillment or test photo upload.

Failure model: mixed/untested artifacts (hash checks and candidate tests), missing production dependencies (actual image startup), schema mismatch or interrupted migration (inventory and transaction), lost settings (configuration comparisons), active job interruption (idle check), failed startup (image rollback), incorrect live reads (post-deployment checks). Existing executable feature specifications and the completed full-suite evidence remain the behavioral baseline.

Reproduce preparation and cutover from `server/` with `sudo -n python3 tools/operator-improvements-deploy.py prepare` and `sudo -n python3 tools/operator-improvements-deploy.py apply`. Preparation is isolated; the apply command performs the authorized production deployment. The `verify` mode reruns read-only operational and served-asset checks.

## Public HTML verification correction

The first cutover reached health and passed the deployed-module checks, then rolled back because Cloudflare inserts one analytics beacon into public Operator HTML. A read-only comparison after rollback proved the prior, healthy release has the same injection; local HTML still exactly matches its image. For public HTML only, remove at most one script with the observed exact Cloudflare source/attribute structure and its appended newline before comparing every remaining byte to the packaged file. Local HTML, JavaScript, CSS and service-worker files still require unmodified SHA-256 equality. Validate this normalization against the captured baseline response before retrying the unchanged image; preserve the first attempt's records.
