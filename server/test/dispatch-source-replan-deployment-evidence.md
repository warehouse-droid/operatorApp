# Dispatch source notices deployment — 28 September 2026

The user explicitly authorized deployment. The final application image is `mbbs-operator-app:dispatch-source-replan-20260928-v2`, image ID `sha256:064ff0d11a07ed004430410e88020681c144ae96ff7ebdef18ed76447b858e30`, deployed at 16:34 UTC.

The four previously verified source files were layered over the current live application image. The newer Special alerts/requester/transfer release was retained. A subsequent HTML-only layer changes the Dispatch script URL to `/dispatch.js?v=20260928-source-replan-v1`, because the public proxy caches JavaScript for four hours. All four verified source hashes are identical in the final image. The worker, database, environment and mounts were preserved; no schema migration was required.

## Release checks

- Captured candidate runtime: 21/21 focused integration, property and Chromium tests passed, including real webhook processing while a prior notice is pending and saving before acknowledgement. Log: `test-artifacts/executed-review-active-lines-release-20260928/release-tests.log`.
- The first candidate run failed to import a shared Field Sales asset because the Docker copy was owned by root with a private directory mode. Correcting ownership of the isolated capture resolved it. No production source or test assertion changed for this correction; the failed log is retained as `release-tests-capture-error.log`.
- Final local and public health endpoints returned HTTP 200. Both served the exact verified Dispatch script. The notice endpoint still returns HTTP 401 without authentication.
- Final local and public `/dispatch/planning` pages reference the new script version; both versioned asset responses match the verified SHA-256 hash.
- Final live SOA09413 replay used a read-only transaction: 3 current lines, salesQty 1426.64, weight 50321.73, zero false notices. The historical acknowledgement remains stored. An in-memory hypothetical change to planned work produces `replanRequested: true`.
- Final application and database Docker health: healthy. The webhook worker is running. All three containers have zero restarts.

The original broader verification remains [recorded separately](dispatch-executed-review-active-lines-evidence.md): zero new failures, with four pre-existing failures. Release testing did not claim those existing failures were fixed. No production webhook or order mutation was created for verification.

## Reproduction and rollback records

`tools/executed-review-active-lines-deploy.py` records preparation, isolated checks, cutover and verification. `tools/executed-review-active-lines-asset-release.py` records the subsequent HTML-only cache-version release. The read-only deployed incident check is `tools/executed-review-active-lines-release-smoke.mjs`, executed through stdin in the application container.

The [source release manifest](../deployments/dispatch-source-replan-20260928/manifest.json) identifies the tested candidate and original application configuration. The [final deployment result](../deployments/dispatch-source-replan-assets-20260928/deployment-result.json), [asset checks](../deployments/dispatch-source-replan-assets-20260928/asset-result.json) and [live replay](../deployments/dispatch-source-replan-assets-20260928/live-smoke.json) identify the final runtime.

Both release directories contain Compose rollback overrides. The source release retains `mbbs-operator-app:rollback-dispatch-source-replan-20260928` (the original pre-release image); the asset release retains the first verified source release. Cutover scripts automatically restore their prior image if application verification fails. No rollback was needed.
