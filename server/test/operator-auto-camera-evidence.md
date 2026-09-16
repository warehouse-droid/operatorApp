# Automatic Operator photo camera

Required photo screens start the existing camera automatically on entry:
delivery fulfillment, customer pickup, reload, consolidation load, purchase and
transfer receiving, pallet return, normal stock return and quality return.
Operators still press Capture for each photo. Close camera stays closed during
rerenders, with manual reopen/retry available. Optional customer pickup photos
do not start the camera when that setting is off.

Startup uses a screen/request identity. Leaving, submitting, completing, closing
or switching cancels an outstanding request; late streams are stopped. Permission
denial gets one attempt per entry and never triggers a repeated fallback prompt.
The text-only toast no longer intercepts touch input. Asset version is
`20260916-operator-auto-camera-v1`; service worker cache is
`mbbs-yard-operator-v153-auto-camera-v1`.

## Validation

- 4 browser tests cover nine photo flows each in desktop Chromium and touch
  WebKit, including capture, manual close/reopen, late success/failure,
  navigation, camera switching, completion, optional-photo configuration and
  pagehide. Media-device boundaries are simulated; actual app camera logic runs.
- Existing Consolidation Load browser suite: 7 passed, preserving date presets,
  single date row, numeric/dropdown entry, five-order pagination and selection.
- UI/reload contracts: 26 passed. Scoped JavaScript syntax checks passed; lint
  comparison has zero new diagnostics (36 existing Operator JS diagnostics).
- Combined packaged release: 39 unit/contract tests and 11 browser tests passed.
  The package also includes the IR Ref No fix and its split-PO regression tests.

The first combined run caught an existing non-interactive toast covering a
touch target after permission denial. The CSS fix makes toasts ignore pointer
input; the unchanged consolidation assertion then passed. Screenshots were
inspected. Browser tests cannot validate a physical device's camera or OS prompts.

## Reproduction

From `server/`, use the installed test images without network:

```sh
sudo -n docker run --rm --network none --ipc=host \
  -v "$PWD/public:/app/public:ro" -v "$PWD/test:/app/test:ro" \
  -v "$PWD/test-artifacts:/app/test-artifacts" \
  --entrypoint node mbbs-mbt-p1-test-e2e:latest --test \
  test/dispatch/frontend/operator-auto-camera.browser.test.mjs \
  test/dispatch/frontend/consolidation-load.browser.test.mjs
sudo -n docker run --rm --network none \
  -v "$PWD/public:/app/public:ro" -v "$PWD/test:/app/test:ro" \
  -v "$PWD/tools:/app/tools:ro" -v "$PWD/eslint.mbt.config.js:/app/eslint.mbt.config.js:ro" \
  -v "$PWD/test-artifacts:/app/test-artifacts" \
  --entrypoint node mbbs-retired-confirm-test:20260914 tools/operator-auto-camera-checks.mjs
```

Exact source hashes and reversible edits: `test/operator-auto-camera-changes.json`.
Logs, scoped diff and screenshots: `test-artifacts/operator-auto-camera/`.
Packaged tests and deployment checks use `tools/operator-camera-ir-reference-deploy.py`.
