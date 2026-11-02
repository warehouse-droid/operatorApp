# Damage stock camera on Windows tablets — deployed 2026-11-02

Deployed at **14:42:37 UTC**. Operators reported that Inventory > Damage could start
the camera on Windows tablets but **Switch camera** did nothing. They also asked for
**Take photo** at the bottom right of the camera preview, with the back camera as
the default. Android tablets use the native camera and are unchanged.

## Cause and fix

The Damage module opened cameras with `facingMode: {ideal}` only. Windows Chrome
often reports no facing mode, so every request returned the default camera.
Damage now uses Customer Pickup's camera selection (`openCameraStream`):
exact facing, then the labelled (Front/Rear) or other device. It starts on the
back camera and the switch button shows the active side. A stream that opens
after the operator leaves is released. The live-preview **Take photo** button
is pinned to the bottom right of `.damage-camera-view`.

## Verification

- Reproduced on the captured live files: both switch tests failed (started
  `front-id`/`cam-a`, still the same after switching).
- Candidate: 34 passed (`test/operator-damage-camera.browser.test.mjs`, Damage
  retry browser, native-camera and camera-rollback units). Customer Pickup camera
  suite: identical before/after (4 passed; 8 existing failures, unchanged).
- Live: six file hashes in the container, local and public asset bytes, health,
  app configuration and the other three services verified. No test containers remain.
- Browser tests simulate media devices; they cannot prove a physical tablet camera.

## Release and rollback

- Image `mbbs-operator-app:damage-camera-20261102`
  (`sha256:abe5ba5acc2e2e9c6955544924fb0dbdef5327f816ea1e3873b33120b12822b1`), app only.
- Previous app `mbbs-operator-app:planner-fixes-3-20261031`
  (`sha256:bf00c6c2776fef2235ede0f40a74d315bc1117a8387cb63102780d693ff36b7f`), tagged
  `mbbs-operator-app:damage-camera-rollback-20261102`. The webhook worker was not changed.
- Helper: `tools/damage-camera-release.py` (prepare, validate, build, deploy, verify).
  Records are in `deployments/damage-camera-20261102/`. To roll back, run
  `rollback-command.txt` there, which is the captured Compose chain plus `compose.rollback.json`.
