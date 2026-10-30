# Combined SCM, split-status, and pickup release — 2026-10-22

Deployed at 20:42:45 UTC following the user's explicit instructions to deploy
the SOA10414 correction with Smart SCM and include Delivery-to-Pickup automatic
release. Image: `mbbs-operator-app:scm-cargo-pickup-20261022`, ID
`sha256:7ad669670a4ea5a55d739b903b69bee22482a26a0df4b92c6954f29476ee405b`.

The release overlays six files on the latest live dispatch image. Smart SCM
counts requested PO quantities toward coverage and leaves remaining demand for
TO planning. Dispatch ignores accounting rows when deriving cargo progress.
Migration 306 releases delivery packing atomically on an effective Delivery to
Pick-Up transition, preserves completed loads, and records before-state audits.
No existing order repair or external NetSuite write was performed.

The exact image's source, public assets, migrations, and dependency manifests
were mounted in the standard isolated Compose configuration. All 125 tests
passed with zero failures, skips, or cancellations, covering the three new
behaviors and adjacent split, SCM, pickup, and packing workflows. Prior broader
component checks and their documented baseline failures remain recorded in the
individual feature evidence. No broader repository or browser suite is claimed.

All 1,446 runtime files match the expected image tree. Live SCM JavaScript and
HTML match the tested hashes. SOA10414's split preview now reports `open` /
`Open`; its canonical status and line digest match the predeployment capture.
The enabled pickup trigger and compiled function match the disposable database
(`functionDigest=1c03797b707a7bd6271f24295db11b89`), and migration 306 is recorded.
The app is healthy; configuration and the three dependency containers are
unchanged. Preflight found no executing business operations.

The original image is retained as
`mbbs-operator-app:scm-cargo-pickup-20261022-rollback`. Deployment audit records
are in `server/deployments/scm-cargo-pickup-20261022`. The release wrapper restores
the previous app and removes the newly installed rule on verification failure;
it preserves any operational audit records.

All validation runs used `mbbs-tests.slice`, bounded containers, and the
repository retention runner. Containers, disposable storage, test image tags,
networks, logs, and runtime copies were removed after each run, including the
failed harness attempts. Both final Docker listings contain only the four
production containers, and health passes.

Harness corrections: tolerate Compose progress lines before structured JSON;
archive component evidence after old-copy retention removed the standalone SCM
release directory. Production and workspace dependency locks are identical;
the sole package-manifest difference is an unrelated test script. Validation
used the exact production package manifest. No runtime changes resulted from
these harness corrections.

Reproduce the combined checks from the repository root while the release image
and operational manifest are retained:

```sh
python3 docker/retention/retention.py run -- python3 server/tools/scm-cargo-pickup-release.py validate
python3 server/tools/scm-cargo-pickup-release.py verify
```
