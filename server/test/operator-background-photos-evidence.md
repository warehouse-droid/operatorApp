# Operator background photos: verification record

Date: 2026-09-17. Spec approval was not obtained; this was an autonomous Tier 3
run under the user's instruction to fix blocking uploads. The contract is in
[operator-background-photos-spec.md](operator-background-photos-spec.md).

Deployment status: deployed after the user explicitly approved “Deploy the
tested fix”. The earlier automatic approval rejection did not execute any
deployment. The live app now runs `mbbs-operator-app:background-photos-20260917`;
health passes and all 17 deployed file hashes match the tested candidate. The
public Operator page, outbox, Operator script and service worker return HTTP 200
and match the release. An initial Python-client request returned 403; repeating
the public checks with a browser user agent succeeded. Migration 204 is present,
203 remains absent, and the webhook worker is unchanged. No production test
Loads were created.

## Result

The final isolated browser replay of SOB120487 + SOB120489 displayed **Load
Complete in 601.22 ms** on a simulated 750 kbps uplink with 50 ms latency. Both
photos were still pending at that point. Transfers completed after 75,342.62 ms,
survived a page refresh, matched the two original SHA-256 digests, and left no
photo bytes in the device queue. Both orders retained both proof references;
exactly two Load records existed. The UI explicitly said photos were uploading
in the background and the operator could continue.

This is a controlled reproduction, not a measurement of the operator's original
connection. The earlier blocking version took approximately 68 seconds in the
equivalent slow-upload replay. The historical report alone does not establish
that the CO change caused the delay; the inspected photo-confirmation functions
were the same before and after that change.

The replay uses actual frontend/Express/PostgreSQL execution, copied order
fixtures and the two reported JPEGs (3,064,255 and 3,063,668 bytes). It adds 30,000
unrelated SO lines and 6,800 TO lines to exercise the scoped Load lookup. Photo
transport goes only to an isolated local service implementing the signed-upload
protocol. No test Load or copied photo was sent to production/external storage.
After refresh, the test explicitly expires the abandoned device lease rather
than waiting its full 150 seconds; production recovery waits for lease expiry.

## Implementation and release scope

Delivery Load, Customer Pickup, Receiving and Consolidation Load save image bytes
in IndexedDB before sending a small manifest to confirm the operation. The
server reserves immutable photo identities in the same transaction as the local
operation. Retrying an accepted confirmation replays its saved result. Device
bytes are removed only after a matching durable server acknowledgment. A
separate server worker uploads to R2 with leases and retries. Stable photo
references resolve to pending proof, staged bytes, or the completed R2 object.
Existing authorization, photo-count policy, CO guards and posting gates remain.

The release is a 17-file overlay on the running image
`mbbs-operator-app:receiving-followup-20260917`, including the separately tested
two-predicate Load lookup optimization. It includes only migration 204, not the
unreleased Return Authorization migration 203. The worker service and unrelated
workspace edits are excluded. There are no new dependencies.

## Checks

| Check | Final result |
| --- | --- |
| Affected suite, forward and reverse order | Each: 258 tests, 256 pass, the same 2 baseline failures, 0 skipped |
| Real Chromium device outbox | 3 pass; additionally 3 consecutive recovery runs passed |
| Migration upgrade and predeploy readiness | 7 pass |
| Exact release schema, including grouped Load and local PO Receiving HTTP paths | 9 pass |
| New server queue module coverage | 118/118 lines, 10/10 functions, 69/70 branches (98.57%) |
| Deliberate server mutants | 4/4 killed |
| Syntax, secret scan, lint and type baseline comparison | No new findings; 151 existing lint and 19,727 existing type diagnostics |
| Final frontend replay | 601.22 ms; refresh recovery and both byte digests verified |

The two pre-existing failures are in `operator-yard-access.test.js`:
“NetSuite pickup lookup confines its query to the assigned yard and checks
returned yard before importing” and “shared inventory sync accepts existing
Control grants or independent Operator grants and rejects empty scopes”. Both
also fail in the unchanged baseline due to their child-process exit assertions.
They were not suppressed or counted as passes. The complete affected set was
run; the entire repository suite was not run.

Coverage above is for `src/operator-background-photos.js`, not every changed
frontend/server file. The four mutants replay a Load twice, allow the wrong
photo owner, accept stale worker completion, or remove the aggregate byte bound.
The property test kills the byte-bound mutant; integration tests kill the other
three. Property checks run 100 cases with seed 20260917.

| Contract | Executable evidence |
| --- | --- |
| Local and native confirmation do not await image transfer | `unit/operator-background-confirm.test.js` (both cases failed before implementation) |
| Atomic Load/reservation, replay and rollback | `integration/operator-background-photos.test.js`, `integration/operator-background-http.test.js` |
| Ownership, yard, digest, size, lease expiry and stale completion | Same integration tests plus `property/operator-background-photos.test.js` |
| Quota rollback, lost acknowledgment, account change and concurrent tabs | `e2e/operator-photo-outbox.test.js` in real Chromium |
| Grouped Load, pending preview, forged references, Pickup and PO Receiving | `integration/operator-background-http.test.js` |
| Actual two-order completion and background refresh recovery | `tools/operator-background-replay.mjs` |
| Existing operational gates and adjacent flows | Persisted list in `test/support/operator-background-suites.json` |

## Reproduction and artifacts

The final complete run was:

```sh
bash server/tools/operator-background-gauntlet.sh
```

It uses isolated Docker networks/databases and the prepared release source in
`server/test-artifacts/operator-background-photos/release/stage`. The private
replay fixtures and the captured baseline must already exist on this host.
`operator-background-package.py` prepares the narrow overlay from the captured
workspace baseline and running image; do not rerun it after deployment as if the
old source were still live. `operator-background-deploy.py build` builds that
overlay. Its `apply` command checks source hashes, verification results, and
unchanged running-service identities before deploying only the app.

Local ignored artifacts under `test-artifacts/operator-background-photos` contain
the baseline, final logs, static comparison, coverage, mutation outcomes and
release manifest. Under `test-artifacts/local-load-performance/replay`,
`background-final-750kbps.json`, `background-final-750kbps-after.png` and the
corresponding video contain the final replay. The manifest records every before,
candidate and workspace hash; both affected-suite reports record tested hashes.
The persisted suite inventory exactly matches the inventory used by these runs.

## Corrections found and limits

Testing caught and corrected the migration operator-ID type, excessive image
decoding time, a partial IndexedDB transaction on synchronous quota failure,
and a resume signal lost during an active queue drain. The recovery assertion
was kept at five seconds. Tooling/setup corrections included using the actual
live source for the static baseline, cleaning test business records between
suites, a task-specific coverage directory, and an explicit online state in the
network-isolated browser fixture. A shell edited while running caused an
infrastructure failure; the complete final run restarted from the frozen files.

Closing or suspending all Operator windows pauses device transfers until the
same account reopens the app on that device. Clearing its site storage before
server acknowledgment can lose pending proof. Unaccepted/abandoned confirmation
photos are retained conservatively and can consume device storage. This run
does not establish a one-second guarantee on every phone, network or database
load, nor upload completion after the browser is closed. Existing Returns photo
flows are outside this Load fix.

The additive migration is safe to retain if deployment fails. An old-image
rollback is allowed only before any new photo action has been accepted: older
code cannot resolve the new references. After acceptance, preserve the durable
queue and repair forward. Deployment results and live source verification are
recorded separately in `release/deployment-result.json`.
