# Receipt confirmation verification

Spec approval: not obtained (autonomous run). The user requested that a
successful NetSuite receipt show its IR. Tier 3 verification covers receipt
identity, recovery races, authorization, and avoiding a second submission.
The spec was stated before implementation; it has not received independent
review. See [acceptance spec](receipt-confirmation-spec.md).

The change retains the successful receipt until Back to Receiving, saves the
actual selected order type, and defers automatic app-update reloads until
acknowledgement. A read-only endpoint recovers the current operator's latest
receipt job for the exact order and yard when an older client has no journal.
Failed jobs do not become successful receipts. Known IR references remain
visible while local verification is pending. Browser storage failures do not
interrupt an in-memory successful confirmation.

The incident replay uses SN1401278, source PO POB03658, recorded IR14813, and
the observed 13.835-second job duration. NetSuite responses are simulated from
the captured incident; replay does not post this receipt to NetSuite again.
The HTTP smoke check additionally exercises the real Express application,
real authentication, the yard guard, and PostgreSQL in an isolated container.

## Acceptance mapping

| Spec | Evidence |
|---|---|
| 1: successful IR retained | Nine browser cases assert IR14813 remains on the receipt screen before acknowledgement; screenshots and traces are retained. |
| 2: reload and actual order type | Unit restoration test; Transfer and CO menu direct-PO-search reload cases. |
| 3: legacy client recovery | Archived older operator script receives an actual controllerchange event, reloads the candidate, then recovers IR14813 without a journal. |
| 4: exact identity and authorization | Real database tests cover operator, yard, type, exact order ID, released claims and latest failed/queued attempts. HTTP tests cover anonymous, other-operator and wrong-yard requests. |
| 5: interrupted or stale recovery | Outage/retry browser case, deferred-response unit test, and 40 generated outage/menu combinations; recovery makes GET requests only. |
| 6: known IR while pending | Attention-state test and completed-then-offline replay retain IR14813 without claiming completed local verification. |
| 7: acknowledgement and partial receipt | Browser acknowledges a partial receipt, reloads and starts a fresh receipt; old journal is cleared and the previous job is not recovered again. |
| 8: app update deferred | Browser asserts no navigation during active receiving and one deferred reload after acknowledgement; unit test preserves packed Transfer Order navigation for local CO. |
| 9: existing flows | Focused photo, posting-stage, local receiving and background-confirm tests; full-suite comparison. |
| 10: storage, escaping and read-only recovery | Storage-quota regression, five corrupt-journal cases, unavailable storage, 100 hostile reference examples, read-only database transaction and per-scenario POST counts. |

## Reproduction and final verification

From the workspace root, run:

```bash
bash server/tools/receipt-confirmation-gauntlet.sh
```

The entry point creates disposable containers and databases using the existing
local `field-sales-check-2941306:latest` image and PostgreSQL 18. It uses the
captured pre-change source and the scoped release baseline under
`server/test-artifacts/receipt-confirmation/`, creates fresh verification
sources, clears previous coverage/browser results, and reruns each layer.
It does not deploy or call NetSuite. The frozen source prevents unrelated
concurrent workspace edits from entering the release or comparison.

| Layer | Final result |
|---|---|
| Focused tests | 58 passed; 0 failed; 0 skipped. |
| Browser replay | 9 passed; IR14813 visible in all; exactly one simulated receipt POST per case; no page errors. |
| Changed executable lines | 94/94: client 59/59, worker 2/2, recovery endpoint 31/31, server wiring 2/2. |
| Manual mutation | 8/8 deliberately broken implementations rejected. Temporary copies preserve the original files. |
| Property/adversarial checks | 40 generated outage/menu combinations; 100 hostile reference examples; five corrupt journals; disabled storage; missing selection; direct legacy result. |
| Static checks | Zero new type diagnostics, lint findings or secret findings. The baseline has 20,299 type diagnostics and 45 lint findings in the checked dependency graph. Syntax checks pass. |
| Suite health | 58 tests pass again in a separate deterministic shuffled file order, seed 1401278. |
| Real application | Authenticated isolated HTTP GET recovers IR14813; anonymous returns 401; another authorized but incorrect yard returns 403; health returns 200. |
| Full suite | Candidate: 3,228 tests, 3,188 passed, 39 failed, 1 skipped, across 600 files. Baseline: 3,207 tests, 3,165 passed, 41 failed, 1 skipped, across 598 files. Zero new failing tests or files. The remaining 39 failures are also present in the deployed baseline. |

The property-only mutation pass kills 1/8 mutants. The other seven are caught
by example-based state/navigation/authorization tests; the properties alone
do not establish those behaviors. The HTML asset version is checked by the
cache contract and browser execution rather than an executable-line count.

Installed versions: Node 20.20.2, ESLint 10.8.0, TypeScript 7.0.2, fast-check
4.9.0, Playwright 1.62.1, Chromium 151.0.7922.34 and pg 8.21.0. Immutable
test-image identities are recorded in `toolchain.json`. Exact candidate source
hashes are in `verification.json` and `release/manifest.json`; logs, screenshots,
traces and coverage are in the same artifact directory.

No dependencies, migrations, feature gates or environment values are changed.
Dependency vulnerability/license audits are not rerun because the dependency
set is unchanged. No multi-device physical-tablet test or fresh live NetSuite
receipt is performed; the operator's exact historical client version is not
recorded, so the original tablet trigger cannot be proven from this replay.

## Failures encountered and resolved

- The initial regression run failed 18 of 19 new cases against the missing
  recovery implementation. The already-working known-IR behavior is retained
  as regression coverage and is rejected by a deliberately broken renderer.
- The new cache contract and CO update-navigation tests failed before their
  respective changes. A storage-quota test exposed and then verified the
  guard around saving browser state.
- Existing extracted-function fixtures needed the state-save/poll-wakeup
  boundaries initialized. Their behavioral assertions were preserved.
- The first combined database check ran alongside infrastructure tests and
  returned an intermittent 500. Focused checks now finish before full suites
  begin, and the real endpoint plus shuffled rerun pass independently.
- Tooling fixes included the archived vendor asset path, the smoke fixture's
  required completion timestamp, and package resolution in temporary backend
  mutants. Import failures were not counted as mutation kills.
- Browser coverage is captured before acknowledgement unloads the script,
  preserving execution evidence for the controllerchange callback.
- Release preparation preserved the deployed authentication middleware after
  a strict patch-context rejection exposed unrelated workspace changes.

## Release

Deployed and verified at **2026-09-25 01:15:36 UTC**. Image:
`sha256:21105b995366891ba399075968750375f746f6de0daa9bbe87c0c30bcc0aa1b8`.

The release changes only
`public/operator.js`, `public/operator.html`, `public/service-worker.js`,
`src/operator-receipt-recovery.js`, and the two router-wiring lines in
`src/server.js`. The release tool retains a rollback image and verifies image
identity, file hashes, application health, configuration and other services.
Local and public health checks returned 200. All five running file hashes
match the tested candidate; all three public assets match over local HTTP and
public HTTPS. Anonymous receipt lookup returns 401. Runtime configuration and
the other services are unchanged.

A read-only transaction using the deployed recovery code returned the original
SN1401278 command and **IR14813**. Incident receipt and command/step counts are
unchanged; no receipt was reposted. Both final isolated environments were
removed after verification. Reload the Operator app before the next receipt
to load the updated client.

See `server/test-artifacts/receipt-confirmation/release/deployment-result.json`
and the retained screenshot
`server/test-artifacts/receipt-confirmation/browser/direct-mobile-legacy-app-update-after.png`.
