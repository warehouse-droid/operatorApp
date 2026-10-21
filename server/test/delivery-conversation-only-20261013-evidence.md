# Sales and Dispatch conversation correction

Deployed at `2026-10-13T22:54:40.935314+00:00` as
`mbbs-operator-app:delivery-conversation-only-20261013`, image ID
`sha256:e7be2c524a4dd854e2e82f22856c6cd7c85ded16a2375d30cdd17f90e2120d74`.
The user requested that system updates be excluded from the conversation;
deployment authorization from the existing session was retained.
Spec approval: not obtained separately (autonomous run). The appended criteria
are in [the delivery specification](delivery-request-enhancements-20261013-spec.md).

The board now shows only written Sales/Dispatch messages. Workflow comments are
stored separately from generated audit descriptions in the existing event
snapshot. Existing comments are recovered using the exact generated prefix from
their previous/current snapshots. Instructions, expiry, reminders and automatic
workflow summaries remain in Request history. Bounded event batches retain earlier
human messages after long legacy histories. Cached retries clean their conversation
at the original response revision, preserving idempotency and excluding later text.

| Acceptance constraint | Executed evidence |
| --- | --- |
| System notices stay in history; earlier messages survive 201 notices | Integration: system instructions/reminders/expiry test, including both private HTTP routes and unchanged audit counts |
| Workflow notes contain only written text; historical summaries remain | Integration: time-change, accept/decline/withdraw, relink and cancel comments; unchanged history after removing new snapshot metadata |
| Old cached replies remain idempotent and exclude later messages | Integration: cached-retry test with an old mixed conversation response; unchanged event/alert counts |
| More than 200 legacy workflow summaries retain an earlier message | Integration: 201 legacy relink events, bounded batch loading, all 205 audit rows retained |
| Both browser boards reject system/staff/blank entries and show empty state | Browser: Sales/Dispatch test, visible Request history, preserved human text mentioning a system update |
| Existing workflow, replies, alerts, rates, quantities and documents | Complete delivery regression/acceptance suite |

The final fresh exact-candidate run passed **169/169 tests**, across 16 shuffled
isolated files, with no failures or skips. Types and scoped lint/complexity passed.
Node/browser coverage executed **355/355 changed delivery lines** against the
recorded original delivery baseline, including every added correction line.
**16/16 manual mutants were detected**, with all source copies restored/removed.
The three quantity mutants were also killed by properties alone. One deliberately
broken revision cutoff failed the cached-retry assertion and then hit the 60-second
mutation timeout by breaking pagination progress; the other 15 exited with test
failures. The disposable container/database were removed after the run.

Production verification passed public/local health (200), both changed asset
hashes, both page asset generations, and private metadata protection (401). Three
existing confirmed requests were checked read-only: their 19 history entries and
audit rows/revisions were unchanged. That sample contained zero written messages
and correctly returned empty conversations. Human-message preservation is covered
by the HTTP and browser acceptance tests.

Only the repository, browser script and HTML asset version were overlaid on the
latest `special-stock-summary-20261013` image. All 1364 runtime source/asset/migration
files were compared. Configuration, other services, intervening stock-summary
changes and every Driver runtime hash were preserved. Driver cache remains v45.
No schema, production audit rewrite, dependency or credential change was required.
An idle-operation check preceded cutover; the exact prior image and Compose
rollback configuration were retained.

The initial regressions failed on unwanted entries before implementation. Further
regressions reproduced stale cached replies and legacy-history overflow before
their fixes. Setup evidence also retains the corrected reminder fixture timing,
test-variable lint error, failed raw-image-ID build and premature missing-candidate
check. No assertions were weakened. Every test stack used the standard bounded
Compose configuration and mbbs-tests.slice, with teardown registered before launch.
Final docker ps/ps -a contained only the four production containers; no task test
networks or volumes remain. App/database/Ollama are healthy; webhook worker runs.

Reproduce from the repository root with a fresh artifact directory:

```sh
DELIVERY_ENHANCEMENTS_SOURCE="$PWD/server/deployments/delivery-conversation-only-20261013/candidate-source" \
DELIVERY_ENHANCEMENTS_ARTIFACT="$PWD/server/test-artifacts/delivery-conversation-only-20261013/repeat" \
bash server/tools/delivery-request-enhancements-test.sh \
  node tools/delivery-request-enhancements-gauntlet.mjs
```

Exact source hashes, versions, suite order, coverage, mutations, browser evidence
and teardown are under `server/test-artifacts/delivery-conversation-only-20261013/final/`.
Final host checks are in its sibling `final-host/`. Deployment manifest, scoped
patch, source capture, image/import/configuration checks, live-read verification
and rollback are under `server/deployments/delivery-conversation-only-20261013/`.
Tool versions match the recorded delivery toolchain. No new supply-chain audit,
latency benchmark, global application suite or physical-device test was added:
dependencies were unchanged and those broader results are not claimed.
