"""Render measured results from the retained, reproducible verification run."""
import hashlib
import json
from pathlib import Path

TASK = Path(__file__).resolve().parent
SERVER = TASK.parents[1]
OUT = SERVER / 'test-artifacts/local-reopen-20261015'
read = lambda name: json.loads((OUT / (name + '.json')).read_text())
final, baseline, red = read('summary'), read('baseline'), read('red')
static, coverage, mutants = read('static'), read('changed-coverage'), read('mutations')
health, cleanup = read('suite-health'), read('cleanup-final')
assert not final['newFailures'] and not coverage['missing']
assert not static['newTypes'] and not static['newLint'] and not static['testLint']
assert all(row['killed'] for row in mutants) and health['fail'] == 0
for file, expected in final['hashes'].items():
    path = TASK / 'candidate' / file if file in json.loads((TASK / 'files.json').read_text()) else SERVER / file
    assert hashlib.sha256(path.read_bytes()).hexdigest() == expected
covered = sum(row['covered'] for row in coverage['files'].values())
total = sum(row['total'] for row in coverage['files'].values())
report = f'''# Local reopen in Dispatch and Operator: evidence

Spec: [local-reopen-spec.md](local-reopen-spec.md). Spec approval: not obtained
(autonomous run). Tier 3; lower confidence than an independently approved spec.
No dependencies or migrations were added. No NetSuite writes were performed.

Reproduce from the repository root:

```sh
bash server/tools/local-reopen-20261015/gauntlet.sh
```

| Layer | Final measured result |
| --- | --- |
| RED against captured live source | {red['fail']} failed, {red['pass']} passed / {red['tests']} |
| Existing relevant baseline | {baseline['pass']} passed, {baseline['fail']} failed / {baseline['tests']} |
| Full relevant suite | {final['pass']} passed, {final['fail']} existing failure / {final['tests']}; zero new failures |
| New tests, reversed file order | {health['pass']}/{health['tests']} passed |
| Changed executable lines | {covered}/{total} covered |
| Manual mutants | {sum(row['killed'] for row in mutants)}/{len(mutants)} killed |
| UI property-only mutants | {sum(row.get('propertyKilled', False) for row in mutants)}/2 killed |
| Type diagnostics | {static['baselineTypeErrors']} baseline, {static['currentTypeErrors']} candidate; zero new |
| Lint and syntax | Zero new runtime or new-test diagnostics; all changed JS parses |
| Native reconciliation scripts | One passes; three reproduce the exact baseline assertion failures |
| Real execution | HTTP delivery/pickup/preparing and Control browser reopen pass |
| Concurrency | Real PostgreSQL row-lock race rejects stale reconciliation |
| Cleanup | Own containers, database volumes and networks removed; production health passes |

The 15 new tests are in `dispatch/integration/local-reopen-workflows.test.js`
and `dispatch/frontend/local-reopen-actions.test.js`. Their behavior mapping is:

1. Spec 1/4: real Operator detail, active-pool and preparing HTTP; customer pickup
   lookup/API; Control browser confirmation and retained images.
2. Spec 2: Dispatch default pool, stale completed snapshot, preserveUnchanged and
   plan scrub; rendered local-open card/actions; 100 fixed-seed two-sided properties.
3. Spec 3: saved work survives actual Billed reconciliation, billing facts conserved;
   normal NetSuite header/line upsert retains reopen until shipped progress arrives.
4. Spec 4/5: actual lifecycle/physical quantities/durable fulfillment matrix;
   actual remote fulfilled progress defeats the exception; a plain open header or
   forged client flag cannot create authority; exact group membership is isolated.
5. Race and hostile input: real concurrent reopen/reconciliation and unsafe SQL
   aliases. Existing Control suites additionally cover roles, yard scope, receiving,
   posting, Driver start, stale previews, idempotency and atomic group locks.

The known browser failure is `{baseline['failures'][0]}`. Its broad
`[role="status"]` locator matches both the reopen result and notification status.
It was neither weakened nor skipped. The new browser test scopes the actual result
to Order Reopen and passes; its screenshot was visually inspected.

Native baseline failures are retained verbatim in artifacts: reconciliation unit
harness line 156 expects an object without the existing `netsuite_order_line:null`;
integration harness line 525 reports `false !== true`; grouped integration harness
line 174 expects `Reconcile Review` but receives `Partially Done`. The final runner
compares the entire assertion failure text against baseline. Later assertions in
those three scripts are not reached; this is a validation limit, not a clean pass.

Failures found and repaired: the first helper/fixture used a PO/TO-only shipped
quantity column; the append-only spec records correction to the actual SO schema.
A durable fulfillment fixture needed its required photo field. The race observer
needed PostgreSQL statistics snapshot clearing; after that correction the test
exposed a real one-direction state check. The implementation now rejects either
direction of changed reopen authority before operational cleanup. Eight new type
diagnostics were corrected with explicit JSDoc types; no errors were suppressed.
Assertions were not weakened. The already-passing authoritative-progress case was
validated by killing a deliberate regression, as required for pre-existing behavior.

The final measured run follows the last runtime edit. Per-file SHA-256 values and
tool versions are in `test-artifacts/local-reopen-20261015/summary.json`. Source is
captured in `tools/local-reopen-20261015/baseline` and `candidate`; no commits or
resets were made in the shared dirty repository. The release overlays exactly 11
files. A concurrent quote-preview release changed only three disjoint files; the
original tested base and newer deployment base are both recorded in
`release-rebase.json`. All reopen baseline files remained byte-identical. Deployment
preserves the concurrent files by hash and verifies them after publication.

Limits: unrelated application suites were not run. Selected manual mutations are
not exhaustive. UI properties cover UI gates; backend authority uses real database,
HTTP and race scenarios. A dependency audit is inapplicable because no package was
added. Runtime introduces no external I/O capability: the new helper performs
bounded-ID/local SQL authority queries using the existing indexed immutable audit.
The two helper functions have single purposes. Runtime changes contain no secrets.
The whole app still has recorded pre-existing type errors.

All tests use the standard bounded Compose configuration in `mbbs-tests.slice`,
with teardown registered before startup. Other tasks briefly had active test
containers during the final suite cleanup; this task's containers, volumes and
networks were removed. Final host listings and production health are recorded by
deployment verification. Operational correction of SOM06964 is separate from tests,
uses the normal audited service, and records the user's explicitly chosen testAdmin
account. Its preflight/result artifacts preserve existing PO allocations and
NetSuite facts. No production credentials or data were mounted into test containers.

Tools: {json.dumps(final['tools'], sort_keys=True)}; Node {final['node']}.
Detailed logs, coverage, mutants, screenshot and cleanup records are in
`test-artifacts/local-reopen-20261015`; deployment and rollback artifacts are in
`deployments/local-reopen-20261015`.
'''
operation_path = OUT / 'som06964-result.json'
deployment_path = OUT / 'deployment-result.json'
if operation_path.exists() and operation_path.stat().st_size and deployment_path.exists():
    operation, deployment = read('som06964-result'), read('deployment-result')
    if operation.get('applied') and deployment.get('localOrderReopened'):
        report += f'''
## Live outcome

Deployed image `{deployment['imageId']}`; new read-only verification at
{deployment['at']} confirms the committed reopen. SOM06964 is locally Open,
eligible for Dispatch planning and visible in Operator's active pool. NetSuite
still says `{operation['status']['status_text']}`. All five allocations to POB04024
and POB04022 remain unchanged. The two pier caps still have no matching PO line;
no allocation was guessed.

The user explicitly selected `testAdmin`. The permanent correction is
`{operation['correction']['correctionId']}`, request `{operation['requestId']}`.
The first operational attempt rolled back because the verification script used
an incorrect property name (`planningEligible`). After correcting it to the actual
authoritative field and confirming rollback in a fresh read-only preflight, the
normal reopen service committed successfully. Runtime code was unchanged.
The final check confirms production health, all runtime hashes, retained concurrent
release files and unchanged service configuration. Only the application container
was replaced; database, worker and Ollama remained untouched.
'''
(SERVER / 'test/local-reopen-evidence.md').write_text(report)
print(json.dumps({'report':'server/test/local-reopen-evidence.md','newFailures':0,
                  'changedCoverage':f'{covered}/{total}','mutantsKilled':len(mutants)}))
