# Production source snapshot — 25 September 2026

This snapshot records the code actually running in the app and webhook worker
at 19:56 UTC. The application runtime in `server/` matches all **1,074 captured
app files** byte for byte. The worker runs a different, older application tree
with the new priority scheduler; `webhook-worker.patch` and `worker-deletions.json` reconstruct all **945
captured worker files** exactly from the app snapshot. That reconstruction was
performed and every file hash compared before committing.

`manifest.json` records image identities, source SHA-256 hashes and applied
migration names. `images.compose.yml` pins the two running image IDs. Existing
deployment configuration and private environment files remain necessary to run
the services; credentials, database contents, uploads, Docker volumes and
`node_modules` are not part of this source snapshot.

The SCM Aggregate alerts, exact submission timestamps, SCM confirmation date
editing and NetSuite Operator priority fix are deployed and included. The
priority release passed 94 app tests, 24 worker tests, actual-image startup and
rollback checks, and live read-only NetSuite probes. This commit does not change
production. A fresh whole-project test run was not needed to record unchanged,
hash-verified deployed files.

## Implemented but not deployed

These are current workspace-to-production differences, verified against the
running containers rather than older task notes:

| Change | Status and evidence |
| --- | --- |
| Dispatch review of source changes on executed orders | Implemented and tested locally. Persistent source-change warnings and acknowledgement endpoints are absent from production. `212_dispatch_executed_order_reviews.sql` is absent from both the app image and applied migration ledger. |
| Dispatch protection against blank addresses | Implemented locally with the executed-order review work. Preserves known addresses during source refresh/draft save and rejects explicit blank edits. The browser/server guard modules and corresponding wiring are absent from production. |
| Special Order quantity-update queue helper | A small local change makes `applySpecialQuantityPlanInNetSuite()` use `queueNetSuiteMutation()`. Production retains its existing mutation-queue wrapper. The shared NetSuite priority scheduler itself is already deployed to both services. |
| Development/test housekeeping | Additional npm test/gauntlet commands, a Driver offline harness update for already-deployed asset versions, and a predeploy-readiness tooling adjustment are local-only. These are not missing application features. |
| Minor source/asset housekeeping | Local Operator return helper functions are moved without changing their bodies; stylesheet/cache-list ordering differs; Sales CSS/sidebar cache-version labels differ. The actual Sales/Operator functionality is present in production. |

The local `src/server.js.orig` file is a backup, not an undeployed feature.
The earlier receipt-recovery and priority-fix notes marked "not deployed" are
superseded by their later releases and the captured production source.

All local runtime differences remain in the working tree, including the two
Dispatch features and their feature-specific tests/tools. Production files were
staged directly from the capture without replacing local working files.
Development tests and tools for the deployed features are included as supporting
repository material; they are not claimed to be files inside the production image.

See `workspace-differences.json` for the exact file list. Migration history also
retains the historical name `055_dual_yard_printer_routing.sql`, which is not a
file in the current app image; it is not newly pending work.

## Verification and reconstruction

The capture/staging procedure is `server/tools/production-snapshot.py`. Its
`verify` command checks the Git snapshot against production file hashes and
checks that pre-existing working files were preserved. Raw captures and private
staging fingerprints remain under ignored
`server/test-artifacts/production-commit-20260925/`.

To reconstruct the worker source, use a clean checkout of this commit and run
the recorded reconstruction tool from the repository root, choosing a new
directory outside the checkout:

```sh
python3 server/deployments/production-20260925/restore-worker.py /tmp/production-worker-source
```

This patch only reconstructs source; it does not deploy anything. Root NetSuite
SuiteScript files are captured as shipped in the container. Their independent
installation inside the NetSuite account was not audited by this Git snapshot.
