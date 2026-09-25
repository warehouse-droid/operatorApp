"""Generate the receiving evidence report from completed verification artifacts."""
import hashlib
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
ARTIFACT = ROOT / 'test-artifacts/receiving-followup'
BACKUP = Path('/home/ubuntu/operatorapp-deploy-backups/receiving-followup-20260917')


def read(name):
    return json.loads((ARTIFACT / (name + '.json')).read_text())


suite, static, coverage, mutations = [read(name) for name in ['suite', 'static', 'coverage', 'mutations']]
properties, browser, full, supplement = [read(name) for name in ['property-mutations', 'browser', 'full-comparison', 'supplement']]
live, after = read('live-candidate'), read('live-after')
deployment = json.loads((BACKUP / 'deployment-result.json').read_text())
assert deployment['deployed'] and deployment['workerUnchanged']
assert live['stateHash'] == after['stateHash'], 'Shipment or receipt evidence changed; investigate before reporting preservation'
assert not full['newFailures']
sources = suite['sourceHashes']
assert all(read(name)['sourceHashes'] == sources for name in ['static', 'coverage', 'mutations', 'property-mutations', 'shuffle', 'full-comparison', 'live-after'])
assert all(deployment['sourceHashes'][file] == value for file, value in sources.items())
assert all(deployment['sourceHashes'][file] == value for file, value in browser['sourceHashes'].items())
assert all(hashlib.sha256((ROOT / file).read_bytes()).hexdigest() == value for file, value in sources.items())
changed = sum(row['total'] for row in coverage['changed'].values())
property_kills = sum(row['killed'] for row in properties['results'])
known = '\n'.join('- `' + file + '`: ' + name for file, name in full['baseline']['failures'])
hashes = '\n'.join('- `' + file + '`: `' + value + '`' for file, value in deployment['sourceHashes'].items())
counts = full['candidate']['counts']
report = f'''# Receiving follow-up and missing-line confirmation

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
- Full project MBT suite: {full['candidate']['files']} files; {counts['tests']} tests,
  {counts['pass']} initially pass, {counts['fail']} initially fail, {counts['skipped']} skipped.
  Four failures expected the old cache release ID. Their exact version expectations
  were advanced to this release, and the popup CSS precache assertion was added.
  The complete four affected test files then passed: {', '.join(full['cacheContractRerun']['counts'])}.
  No implementation changed between the full run and this rerun. There are
  **0 unresolved new failures**; the five original baseline failures remain.
  Baseline: {full['baseline']['files']} files and {full['baseline']['counts']['tests']} tests.
- Changed backend lines: {changed}/{changed} executed. New helper: 86/86 lines,
  7/7 functions, 45/50 branches (90%). Browser popup: 34/34 changed lines executed.
- Six of six manual mutants killed by assertion/property failures. Property-only
  rerun kills {property_kills}/6: it catches overlapping-counter double counting and
  loss of sequential progress. Status filtering, confirmation retirement,
  parent resolver wiring and duplicate local evidence are covered by examples,
  not by those two generated properties. This is an explicit property-layer limit.
- Generated cases: a 35-case local/remote quantity property with three fixed examples
  (seed 14645), and 100 sequential receipt cases (seed 1400625).
- Static backend checks: 0 new findings; {static['lintCount']} existing lint findings
  and {static['existingTypeDiagnostics']} existing transitive type diagnostics remain.
  The new helper has no type diagnostics. Frontend lint has 0 new findings
  against its baseline (815 operator and 4 service-worker existing findings).
- Secret scan: {supplement['scannedFiles']} task files, 0 findings. Python and shell
  syntax checks and whitespace checks pass. No dependencies or migrations added.
- Four Chromium scenarios pass with 0 page errors and 0 receipt submissions.
- Live deployed draft selects only REST orderLine 34, quantity 28, with SN1400625
  in both reference fields. Every selected/unselected payload row exists on the
  current open NetSuite source. Prior IR14645 still has only its three products.

The five pre-existing full-suite failures are:

{known}

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

Tool versions: Node {supplement['node']}, TypeScript {supplement['versions']['typescript']},
ESLint {supplement['versions']['eslint']}, fast-check {supplement['versions']['fast-check']},
c8 {supplement['versions']['c8']}, Playwright {supplement['versions']['@playwright/test']};
test images `mbbs-retired-confirm-test:20260914` and `mbbs-mbt-p1-test-e2e:latest`.
No Git reset, staging or commit was performed; source hashes identify this result.

`receiving-followup-assets.py` applies only this popup to the captured deployed
frontend, preserving unrelated local return-workflow edits. The release image is
`mbbs-operator-app:receiving-followup-20260917`; the app health check passes and the
webhook worker is unchanged. Rollback image/Compose configuration and exact
before/after files are retained in `{BACKUP}`.

Final deployed hashes:

{hashes}

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
'''
(ROOT / 'test/receiving-followup-evidence.md').write_text(report)
print(json.dumps({'report': 'server/test/receiving-followup-evidence.md', 'newFailures': 0,
                  'deployed': True, 'receiptSubmitted': False, 'sourceHashes': deployment['sourceHashes']}, indent=2))
