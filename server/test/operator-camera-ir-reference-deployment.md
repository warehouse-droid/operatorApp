# Operator camera and IR reference — deployed 2026-09-16

Deployed at **03:23:57 UTC**, after the user's regression requirement was met.
Required photo screens in `/operator` now open the camera automatically. New
IRs set both **Memo** and **Ref No** (`custbody9`) to the receiving order
reference, such as SN1400333, while retaining the actual source PO and lines.

## Verified outcome

- Full candidate: **2,507 passed**, one existing fixture failure, one existing
  skip, **zero new failures** against the complete baseline.
- Focused posting checks: **74 passed**. Packaged release: **50 passed**
  (39 unit/contract and 11 desktop/touch browser tests).
- App and worker run the verified image with **zero restarts**; app is healthy.
  Local and public health returned HTTP 200. All ten local/public asset hashes
  matched. Anonymous consolidation API retained HTTP 401.
- Configuration, mounts, ports and commands preserved; database and Ollama
  identities/start times unchanged. Active postings, photo uploads and webhooks
  were all zero immediately before cutover. No migration or live IR was created.
- Exactly six files changed from the previous app image: Operator JS, CSS,
  HTML, translations, service worker and the posting domain module.

## Release and rollback

- Image tag: `mbbs-operator-app:operator-camera-ir-reference-20260916-v1`
- Image ID: `sha256:e3cbbe3bda58be7694dcd666d9757fb671763656efcd322ea53e7a5111f82a6d`
- Prior app: `sha256:bda008499b453613391ea97f7e1f44f32c73364cab09a417b378f3a432fe4d13`
- Prior worker: `sha256:0ce822ac692745f914776588ecd77f58f5798cbe9047e9dc1b2694f4ad1102fb`
- Rollback tags: `mbbs-operator-app:rollback-camera-ir-reference-app-20260916`
  and `mbbs-operator-app:rollback-camera-ir-reference-worker-20260916`.
- Cutover: **03:23:46–03:23:57 UTC**. No rollback was needed.

Private manifest, captured configuration, packaged test logs, release/rollback
Compose overrides and verification results are stored under
`/home/ubuntu/operatorapp-deploy-backups/operator-camera-ir-reference-20260916/`.
To roll back, apply `compose.rollback.yml` last over the captured Compose file
chain, with `up -d --no-deps --no-build --pull never app webhook-worker`.

Deployment helper: `tools/operator-camera-ir-reference-deploy.py`.
The helper refuses stale regression evidence and source hashes and retains
automatic rollback on failed health, configuration, startup or asset checks.

[Camera evidence](operator-auto-camera-evidence.md) ·
[IR evidence and limitations](ir-po-reference-evidence.md) ·
[IR executable acceptance criteria](ir-po-reference-spec.md)
