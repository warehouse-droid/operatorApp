# Compact Consolidation Load date row — deployed 2026-09-16

Deployed at **02:27:55 UTC**, following the user's instruction to deploy directly. Planned date presets and the specific year/month/day controls now share one row on desktop and mobile. Small field labels sit inside the date boxes, and the range/help text shares the line below. All three quick choices, numeric entry and five-order pagination remain available.

## Verification

- Existing browser suite: 7 passed; desktop and mobile screenshots inspected.
- Packaged release: 21 unit/contract tests and 7 browser tests passed.
- Live app: healthy, zero restarts; local and public health returned HTTP 200.
- All 10 local/public asset probes matched the verified image; anonymous consolidation API returned HTTP 401.
- Image comparison found exactly four changed files: Operator JS, CSS, HTML and service worker. The unchanged i18n file was also hash-verified.
- Environment, mounts, ports and commands preserved. Worker, database and Ollama container identities/start times unchanged. No migrations or live business transactions were used for verification.

## Release and rollback

- Release: `mbbs-operator-app:consolidation-date-row-20260916-v1`
- Image: `sha256:bda008499b453613391ea97f7e1f44f32c73364cab09a417b378f3a432fe4d13`
- Previous app image: `sha256:328d6f4252c46f1e79cedbd232717c0e3515d8111926f94b4d8d3ddca5364100`
- Rollback tag: `mbbs-operator-app:rollback-consolidation-date-row-20260916`
- Cache: `mbbs-yard-operator-v152-consolidation-date-row-v1`
- Successful cutover: **02:27:45–02:27:55 UTC**.

Private release records: `/home/ubuntu/operatorapp-deploy-backups/consolidation-date-row-20260916/`. The directory includes the manifest, captured configuration, packaged test results, live verification and rollback Compose override. Apply that override last over the captured Compose chain with `up -d --no-deps --no-build --pull never app` to restore the previous app image.

Local source hashes, scoped diff, browser log and reviewed screenshots: `test-artifacts/consolidation-date-row/`. Deployment helper: `tools/consolidation-date-row-deploy.py`, reusing the previous UI deployment flow with explicit app/worker baselines and the existing strict health/asset checks.
