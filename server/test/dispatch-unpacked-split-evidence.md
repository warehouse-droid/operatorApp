# Unpacked orders blocked from splitting — 2026-09-14

Status: **deployed on 2026-09-14 after explicit user approval; production checks passed**.

## Confirmed cause

Production Sales Orders SOM06255 (980538) and SOM06256 (980542) were unpacked at
12:59:20 UTC and 12:59:34 UTC. Both headers are `open` / `Open`; all their packed
and loaded quantities are zero. The earlier unpack request for SOM06255 is resolved.
No order-data repair is necessary.

Dispatch compact cards omit `operatorStatus` and `localYardOrderStatus`. Merging
these cards into an already hydrated order retains the previous packed status.
Opening Split previously trusted that client state, and the queued order refresh
updated the order pool without redrawing an open split dialog. The catalog detail
documents had already reached `open`, but the screen could still report packed.

## Change

- Opening Split reads the authoritative source feed for the selected canonical
  SO/TO, matches its exact reference, and requires a returned packing status.
- Existing local group membership is preserved.
- An open split dialog refreshes its source order and redraws after the queued
  live-event refresh. A closed or different dialog is not reopened.
- Failed reads report an error without opening the split editor. Current packed
  and loaded statuses continue to block splitting.
- The script URL includes `split=20260914-v1` so a page refresh loads the new code.

No canonical orders, inventory quantities, plan snapshots, credentials, database
schema, dependencies, or worker code were modified. No actual splits were created.

## Verification

The five browser tests all failed against the original implementation, reproducing
the stale status, live dialog, loaded-status freshness, and failed-read behaviors.
The final browser run passed **5/5**, with the real Dispatch page running inside a
network-isolated container and API responses supplied at the transport boundary.
The catalog detail response deliberately remains packed while the source feed is
open, demonstrating that merely rehydrating cached details is insufficient.

Browser command (use the project's installed Playwright dependencies):

```sh
MBT_TEST_ISOLATED=1 npx playwright test --config test/dispatch-unpacked-split.playwright.config.mjs
```

In this workspace, the existing `mbbs-mbt-p1-test-e2e:latest` image supplied
Playwright. `public/` and `test/` were mounted read-only; Docker used `--network none`.

Existing regressions passed **40/40**:

```sh
node --check public/dispatch.js
node --test test/dispatch/frontend/dispatch-unplan-freshness.red.test.js test/dispatch/frontend/sales-order-group-hydration.red.test.js test/dispatch/frontend/dispatch-planner-performance.contract.test.js
npx eslint --config eslint.mbt.config.js --max-warnings=0 test/mbt/e2e/dispatch-unpacked-split.spec.js
```

Syntax, test lint, and `git diff --check` passed. An initial test lint failure for
unqualified `localStorage` references was corrected to `globalThis.localStorage`;
the final lint and browser runs passed. The entire repository suite was not run
for this two-file frontend change.

Read-only execution of the running application's `listDispatchOrders` returned
`open` / `Open` for both orders (804 ms and 713 ms respectively). Runtime source
files matched the original worktree before editing, and `docker diff` confirmed
there were no additional runtime-code edits in the running container.

Logs: `server/test-artifacts/unpacked-split/{red,green,regressions,lint}.log`.

## Release and rollback

Deployed image: `mbbs-operator-app:unpacked-split-20260914-v1`.
It derives from `mbbs-operator-app:stale-address-20260911-v1` and copies only
`public/dispatch.js` and `public/dispatch.html`.

Final SHA-256:

```text
bf6020b629de3a189ec82c22528c773371d78cb9435beab73243483d08ff6a74  public/dispatch.js
97cca4f46df1183cd75cac9f03012948b1ee01212b6db49f7e39c19e4bdf9f63  public/dispatch.html
```

Release files and Compose override:
`docker/backups/unpacked-split-20260914/`.
Original assets and prior Compose override:
`/home/ubuntu/operatorapp-deploy-backups/unpacked-split-20260914/`.

Deployment command, run from the repository root after the user approved `deploy`:

```sh
docker compose --env-file docker/env/.env -f docker-compose.yml -f docker/backups/unpacked-split-20260914/compose.override.yml up -d --no-deps --no-build --wait --wait-timeout 45 app
```

This recreated only the app service, preserving the existing worker image and
configuration. Rollback uses the previous override at
`docker/backups/stale-address-20260911/compose.override.yml` with the same command.

The initial deployment attempt was rejected by automatic approval review because
the issue report did not explicitly authorize a production restart. The user's
subsequent `deploy` instruction authorized the same prepared deployment.

## Production post-checks

- App started at `2026-09-14T13:10:44.26924401Z`, became healthy, and had zero restarts.
- `/health` returned HTTP 200.
- `/dispatch/planning` and `/dispatch.js?split=20260914-v1` returned HTTP 200;
  their SHA-256 hashes exactly matched the tested files listed above.
- The served HTML includes the new `split=20260914-v1` script version.
- A read-only transaction ran the deployed source-order reader and the deployed
  `splitBlockReason` function for both SOM06255 and SOM06256. Both returned
  `operatorStatus: open`, `localYardOrderStatus: Open`, and an empty split-block
  reason. Packed sales quantities and loaded quantities remained zero.
- The webhook worker retained container ID
  `6be750e959e3aa06dc9d34e3da1d6617f5904626f0dd8af782484ac4279ec8b7`
  and its existing `2026-09-11T21:09:10.902424187Z` start time.

Existing browser tabs need a page refresh to load the new frontend script.
