# Receiving follow-up and missing-line confirmation

Deployed the receiving correction and confirmation popup. SN1400625 now exposes
only PALLET, quantity 28. The next operator receipt creates a distinct IR for that
line; IR14645 remains the original three-product receipt. No production IR was
submitted during verification.

spec approval: not obtained (autonomous run)

Tier 3 because receipts change inventory. Spec: [receiving-followup-spec.md](receiving-followup-spec.md).

## Cause and correction

Successful local receipt records were not subtracted when the operator detail
was rebuilt. The old product confirmations therefore remained reusable. In
addition, cached source PO completion counters predated IR14645, leaving fully
received NetSuite orderLine 25 in the subsequent static-sublist transform.

The detail now projects exact successful receipt quantities by local order and
line, consumes confirmations predating those receipts, and overlaps local
evidence with NetSuite counters rather than adding the same receipt twice.
Verified posting evidence also removes completed parent transform lines. Receipt
recording is atomic with its audit and serializes replay of the same real IR.
Raw source rows and prior receipt records are preserved.

The Receive popup counts outstanding lines across every page. Three confirmed
lines out of four produces “1 of 4 lines are still unconfirmed,” identifies the
missing SKU, and offers Go back or Receive confirmed lines. Escape and Go back
preserve confirmations; proceeding opens the existing photo flow.

## Acceptance mapping

| Spec | Executed evidence |
|---|---|
| 1: only PALLET 28; separate IR; prior IR unchanged | Incident integration tests 1–2 and read-only live draft before/after deployment |
| 2: omit completed REST line 25; retain unselected open rows | Follow-up draft test, source identity unit tests, live NetSuite PO comparison |
| 3: exact line/split progress, statuses, duplicates and overlap | Integration tests 4, 7, 9; generated receipt-total property; mutation tests |
| 4: remaining balance, fresh confirmation, atomic/idempotent recording | Integration tests 3, 5, 6, 8; eight simultaneous replay calls create one receipt and one audit |
| 5: popup, all-page count, cancellation, continuation, repeated taps | Four real Chromium scenarios; Escape/repeated-click checks; changed frontend coverage |
| 6: TO/CO/photo/closed-order/allocation behavior | 99 existing adjacent tests plus complete MBT baseline comparison |
| 6: earlier fixes and unrelated frontend work preserved | Seven-file image overlay; deployed source hashes; preserved module/asset hashes; worker unchanged |
| 6: no production receipt during verification | Read-only transactions, no posting calls, identical shipment/receipt state hash before and after |

## Final checks

- Original behavior: all 9 final incident integration tests fail on the frozen
  baseline. The original browser flow also fails because the warning is absent.
- Focused and adjacent suite: 112 tests pass, 0 fail; all 112 pass again in a
  deterministic shuffled file order, seed 14645. Thirteen tests are new.
- Full project MBT suite: 515 files; 2649 tests,
  2639 initially pass, 9 initially fail, 1 skipped.
  Four failures expected the old cache release ID. Their exact version expectations
  were advanced to this release, and the popup CSS precache assertion was added.
  The complete four affected test files then passed: # tests 16, # pass 16, # fail 0, # skipped 0.
  No implementation changed between the full run and this rerun. There are
  **0 unresolved new failures**; the five original baseline failures remain.
  Baseline: 512 files and 2636 tests.
- Changed backend lines: 128/128 executed. New helper: 86/86 lines,
  7/7 functions, 45/50 branches (90%). Browser popup: 34/34 changed lines executed.
- Six of six manual mutants killed by assertion/property failures. Property-only
  rerun kills 2/6: it catches overlapping-counter double counting and
  loss of sequential progress. Status filtering, confirmation retirement,
  parent resolver wiring and duplicate local evidence are covered by examples,
  not by those two generated properties. This is an explicit property-layer limit.
- Generated cases: a 35-case local/remote quantity property with three fixed examples
  (seed 14645), and 100 sequential receipt cases (seed 1400625).
- Static backend checks: 0 new findings; 6 existing lint findings
  and 3526 existing transitive type diagnostics remain.
  The new helper has no type diagnostics. Frontend lint has 0 new findings
  against its baseline (815 operator and 4 service-worker existing findings).
- Secret scan: 28 task files, 0 findings. Python and shell
  syntax checks and whitespace checks pass. No dependencies or migrations added.
- Four Chromium scenarios pass with 0 page errors and 0 receipt submissions.
- Live deployed draft selects only REST orderLine 34, quantity 28, with SN1400625
  in both reference fields. Every selected/unselected payload row exists on the
  current open NetSuite source. Prior IR14645 still has only its three products.

The five pre-existing full-suite failures are:

- `test/mbt/infrastructure/p3-gauntlet-artifacts.test.js`: P3 gauntlet artifacts: CI always uploads the bounded artifact directory with a pinned action
- `test/mbt/infrastructure/p3-gauntlet-contract.test.js`: P3.11: the extended mutation manifest owns every dedicated runner and the P3 gauntlet executes it
- `test/mbt/infrastructure/p3-gauntlet-contract.test.js`: P3.12: browser specs share one worker-owned database-pool lifecycle
- `test/mbt/infrastructure/production-runtime-contract.test.js`: quality non-regression: the gauntlet builds and validates the omit-dev runtime
- `test/mbt/integration/local-load-performance.test.js`: /app/test/mbt/integration/local-load-performance.test.js

The local-load-performance test refuses the full runner's per-file clone database
name; the other failures are existing gauntlet/runtime contract fixtures. These
were retained and compared, not suppressed or repaired in this task.

## Reproduction and deployment

Run `bash server/tools/receiving-followup-gauntlet.sh` from the repository root.
It reconstructs the original nine files using the persisted baseline patch and
uses disposable PostgreSQL containers for RED, regression, full-suite, coverage,
mutation, shuffled, lint, secret-scan and browser checks. Production state replay
is separately available as `python3 server/tools/receiving-followup-live.py`
and `python3 server/tools/receiving-followup-live.py --deployed`; both are read-only.

Tool versions: Node v20.20.2, TypeScript 7.0.2,
ESLint 10.8.0, fast-check 4.9.0,
c8 12.0.0, Playwright 1.62.1;
test images `mbbs-retired-confirm-test:20260914` and `mbbs-mbt-p1-test-e2e:latest`.
No Git reset, staging or commit was performed; source hashes identify this result.

`receiving-followup-assets.py` applies only this popup to the captured deployed
frontend, preserving unrelated local return-workflow edits. The release image is
`mbbs-operator-app:receiving-followup-20260917`; the app health check passes and the
webhook worker is unchanged. Rollback image/Compose configuration and exact
before/after files are retained in `/home/ubuntu/operatorapp-deploy-backups/receiving-followup-20260917`.

Final deployed hashes:

- `src/receiving-repository.js`: `8f2449d12970171d169ec59f225bce6767effcf160ed42b84b7a377943fc5fc5`
- `src/operator-netsuite-posting-targets.js`: `12895479dab75865740068099b24aa1b83fd3f57a378c947a03a512173035d3c`
- `src/receiving-receipt-progress.js`: `15ead9572ad03e6ef93d17788bb0f31226be66f8af32fb8c103c4211489e0263`
- `public/operator.js`: `e10604bd48ffb0b1fb8712b01ef12b47742200c6c1383046a31bfc3ff36c1de7`
- `public/operator.html`: `18c6a89a1cfed9891244d1af5f95320726e1d8fb0f7d001c6a4b381bc56b2ec7`
- `public/service-worker.js`: `5d7ea8b2bb1c51aa84ae690569ee68f1cb675b3fa297e0dbe88f05e94fb9a20e`
- `public/operator-receiving-confirmation.css`: `396f3c17b5469a9628b7da2c688ea8dc23c397b5fb532eca1ba97c3253434859`

## Limits and resolved check failures

No live receipt was posted as a test. NetSuite's eventual creation of the next IR
therefore remains the operator's action with the required photos. Inventory
reversal/void handling and historical external IRs without local posting evidence
are outside this change. Existing photo, source identity and posting claim policy
remain in force. Dependency audit was not rerun because dependencies are unchanged.
The helper functions each have one receipt-progress responsibility; no additional
network capability was introduced into the posting resolver.

During verification, the first browser image lacked its Chromium binary and a
fixture initially ignored the existing three-lines-per-page layout. The existing
browser image and corrected harness exposed the real missing-warning failure.
Argument type annotations and three new missing-brace lint findings were corrected.
A coverage run overlapping an annotation edit was discarded and rerun. Superseded
full-suite runs were stopped; reported results use the final unchanged sources.
Four cache-version assertions were updated after the full run, retaining every
behavioral assertion and adding a popup stylesheet check; their targeted rerun
is reported separately rather than presenting the initial full run as all green.
Docker's default network pool was temporarily full; checks were serialized and
only this task's disposable containers were stopped. No assertions were weakened.
