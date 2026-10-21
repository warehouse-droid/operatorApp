# Regular Stock physical balance evidence — 2026-10-16

Deployed on **2026-10-16 at 05:53 UTC** for the **Pickup and Delivery** request types that link to a Sales Order. The separate **Backorder** request type and **Stocking** retain their existing behavior. No schema migration or manual production NetSuite business write was performed for this deployment.

An open line uses `max(ordered - fulfilled, 0)`; a closed line has zero actionable balance. Billing does not block the remaining physical work. Routing, Delivery transfer calculation, saved approval checks, kit comparisons and confirmation tokens use this distinction. Original SO quantities and rates are preserved.

## Specification and authorization

[Specification](regular-stock-remaining-spec.md). Core behavior was explicitly approved in the conversation. Detailed executable spec approval: not obtained separately (autonomous run). Tier 3 was used because incorrect quantities could create an excessive stock transfer. This is evidence for the specified behavior, not proof of every possible NetSuite configuration or concurrent external action.

## Final results

Both final phases used the same frozen application/test source, which was subsequently compared with the workspace. No application code changed between those phases. The reverse-order driver was corrected to execute files individually because Node sorts a multi-file invocation; its corrected version was linted in that final phase.

| Layer | Actual result |
| --- | --- |
| New focused regression/property/integration tests | **22 passed, 0 failed** |
| Full affected Regular Stock suite | **319 tests: 317 passed, 2 pre-existing failures, 0 new failures** |
| Actual reverse file order, fresh database | **319 tests: 317 passed, the same 2 pre-existing failures** |
| Types | `tsc -p tools/regular-stock-delivery-simple-tsconfig.json`: exit 0 |
| Lint | All six application files, three new test files and both JS runners: 0 diagnostics; updated runner rechecked after its change |
| Syntax/whitespace | All six application files, both shell scripts, scoped `git diff --check`: pass |
| Changed-line coverage | **62/62 mapped changed lines covered**, including the two UI lines using recorded browser V8 coverage |
| Manual mutation | **9/9 caught** by focused unit/property tests; restored source **19/19 passed** |
| Properties alone against mutations | **7/9 caught**; native terminal status and confirmation-token faults are covered by explicit unit cases, not these properties |
| Generated properties | **380 cases**, fixed seeds 161026, 161027, 161028, 161029 |
| Real application execution | Existing HTTP and desktop/mobile browser workflows ran against the real app with external NetSuite boundaries replaced by fixtures; new database scenarios created/retried only the approved remaining transfer |
| Dependencies/capabilities | No dependency, schema, credential, or new runtime network/subprocess/filesystem capability changes; focused secret scan: 13 files, 0 findings |
| Cleanup | All this task's containers, disposable database storage and networks removed; production app/database/Ollama healthy, webhook worker running |

The two pre-existing failures are:

1. `SQL lists and detail authorization agree across yards, methods and versions` — observed before implementation in the baseline suite.
2. `changing queues discards an unfinished Resolve reply without submitting or closing the case` — observed before implementation after correcting browser setup in the RED run.

They were not skipped or weakened. The runner permits only these exact baseline failure names; a new failure still fails the gauntlet. Another thread's active Driver test container was present at final cleanup and was not removed.

## Behavior-to-evidence mapping

| Spec behavior | Evidence |
| --- | --- |
| Billing-independent eligibility, native partial statuses | `billed open and partly fulfilled lines expose their physical remaining balance`; billing/quantity property |
| Closed/fully fulfilled balance zero; unrelated closed lines ignored | `closed and fully fulfilled lines have zero actionable balance`; routing and Delivery closed-line cases |
| Match and allocate only remaining stock | Routing mismatch case; existing duplicate-row conservation tests; generated allocation cases |
| Transfer caps, backorder bounds, availability and decimal units | Delivery 100/40→60 case, 313.5/125.4→188.1 case, generated backorder/availability cases |
| Billing-only kit changes and confirmation survive | Dedicated kit snapshot and token tests; kit property; integration retry after billing activity |
| Stale fulfillment/closure cannot execute | Unit location-write rejection, legacy snapshot test, generated stale progress cases, database retry test |
| Location-only mutation preserves quantity/rate/header/identity | Existing adapter/ancillary/kit tests plus billed partial retry and closed ancillary cases |
| Malformed evidence rejected | Reader adversarial cases and malformed supplied-fulfillment test |
| UI says remaining quantity | Existing desktop/mobile selection browser test, screenshots and V8 execution coverage |
| Native terminal SO checks retained | Explicit native C/F/G/H unit case and mutation |
| Financial-edit protections and PO receipt calculation retained | Those adapters were not modified; task-only patch review. This task fixes the Regular Stock SO eligibility guard; no PO financial mutation or receipt policy was rewritten |

## Reproduction and source identity

From the repository root on this application host:

```sh
sudo -n bash server/tools/regular-stock-remaining-gauntlet.sh
```

The persisted runner uses `docker-compose.mbt-test.yml`, unique project names, a frozen source copy, and cleanup traps registered before startup. It reuses the installed `mbbs-to-yard-test-browser:20261009` image and existing declared dev dependencies in `server/test-artifacts/driver-upload-reliability/toolchain/node_modules`. Actual image ID: `sha256:e0004cd5eb8f755f20f015fdc9d93fb2e346e600a1b7388245903cd05a804ba1`.

Recorded versions: Node v20.20.2, fast-check 4.9.0, TypeScript 7.0.2, ESLint 10.8.0, c8 12.0.0. No tooling was installed during this task. Test processes used `mbbs-tests.slice`, init, a 2 GiB memory/swap limit, 2 CPUs, 512 PIDs and bounded tmpfs; PostgreSQL used the standard 1 GiB/1 CPU/256 PID limits and disposable tmpfs.

Source manifest hash: `30c2cf52a3b3e3ab98f03781f259f96dcea5804104a18aae95e07b5712264935`.

Artifacts are under `server/test-artifacts/regular-stock-remaining-20261016/`: `final/report.json`, `reverse/report.json`, `source-verification.json`, `changed-lines.json`, `task.patch`, `secret-scan.json`, `cleanup-final.json`, per-phase test/mutation logs, teardown logs and browser evidence. The dirty shared repository was not reset or committed; the task-only baseline and patch preserve unrelated work.

## Iteration history and limits

The original implementation failed the new billed/partial/closed/kit/confirmation cases. A later adversarial case exposed missing validation of malformed fulfillment in a supplied snapshot; its guard was added after observing RED. The full suite caught an existing exact error-message contract; original wording was retained for unfulfilled lines. Isolated-runner issues (working directory, browser configuration, copied-file ownership, browser coverage format, and Node file ordering) were corrected without weakening test assertions.

The final checks cover the full affected Regular Stock suite, not every unrelated module in this large application. There is no new dependency audit or database rollback rehearsal because no dependency or schema changed. External NetSuite boundaries are simulated in write-path tests; the earlier read-only NetSuite audit established the live billing/fulfillment examples. Existing read-before-write checks cannot make a separate NetSuite operation atomic against changes made by another external client.

## Production deployment

The user explicitly requested deployment. All six live files matched the captured task baseline. The release extends the running `transfer-eta-20261016` image and copies exactly the six verified application files; its existing image layers and image configuration were verified unchanged. The shared working tree was not used as a full deployment context.

- Release: `mbbs-operator-app:regular-stock-remaining-20261016`.
- Rollback retained: `mbbs-operator-app:rollback-regular-stock-remaining-20261016`.
- Additional checks against the captured production source plus this fix: **23/23 passed**, including all 22 focused cases and the desktop/mobile Delivery selection browser workflow.
- Only the application service was recreated. Its runtime configuration and resource policy were preserved; database, webhook worker and Ollama container identities were unchanged.
- The app reported healthy with zero restarts. Both local and public `/health` returned 200, both served the exact expected Delivery JavaScript hash, and all six deployed file hashes matched the tested versions. No fatal startup errors were found.
- Final `docker ps` and `docker ps -a` contained only the four production containers. This task's disposable containers, database storage and networks were removed.

The first deployment attempt passed application health but the public verification request received Cloudflare 1010/403 for Python's HTTP client. Automatic rollback restored the original image. The same public denial was reproduced on the original image, while the established Node-based probe returned 200. The probe was corrected and the identical tested image was successfully deployed; no application code changed for the retry.

Release manifests, image verification, preserved first-attempt/rollback records, private startup log and deployment results are in [`server/deployments/regular-stock-remaining-20261016`](../deployments/regular-stock-remaining-20261016). Additional test and cleanup records are in `server/test-artifacts/regular-stock-remaining-20261016/deployment-check`, `deployment-result.json` and `deployment-cleanup.json`.
