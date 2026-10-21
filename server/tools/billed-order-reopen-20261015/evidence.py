"""Render the final measured evidence; never infer a missing result."""
import json
from pathlib import Path

TASK = Path(__file__).resolve().parent
SERVER = TASK.parents[1]
OUT = SERVER / 'test-artifacts/billed-order-reopen-20261015'
read = lambda name: json.loads((OUT / (name + '.json')).read_text())
final, baseline = read('summary'), read('baseline')
static, coverage, mutants = read('static'), read('changed-coverage'), read('mutations')
health, cleanup = read('suite-health'), read('cleanup-final')
assert not final['newFailures'] and not coverage['missing']
assert not static['newTypes'] and not static['newLint'] and not static['testLint']
assert all(row['killed'] for row in mutants) and health['fail'] == 0
covered = sum(row['covered'] for row in coverage['files'].values())
total = sum(row['total'] for row in coverage['files'].values())
report = f"""# Billed order reopen and PO link evidence

Spec: [billed-order-reopen-spec.md](billed-order-reopen-spec.md).
Spec approval: not obtained (autonomous run). Tier 3, calibrated to the local
fulfillment safeguards. No dependencies, database migrations or NetSuite writes.

Reproduce from the repository root:

```sh
bash server/tools/billed-order-reopen-20261015/gauntlet.sh
```

The captured source is in tools/billed-order-reopen-20261015/baseline and the
verified source is in candidate. Per-file SHA-256 values are in
test-artifacts/billed-order-reopen-20261015/summary.json. Base image and capture
identity are in tools/billed-order-reopen-20261015/capture.json. No commits were
made in the existing dirty workspace; the deployment overlays three files only.

| Layer | Final measured result |
| --- | --- |
| Existing baseline | {baseline['pass']} passed, {baseline['fail']} failed / {baseline['tests']} |
| Full relevant suite | {final['pass']} passed, {final['fail']} baseline failure / {final['tests']}; zero new failures |
| New tests, reversed file order | {health['pass']}/{health['tests']} passed |
| Changed executable lines | {covered}/{total} covered |
| Manual mutation tests | {sum(row['killed'] for row in mutants)}/{len(mutants)} killed |
| UI property-only mutations | {sum(row.get('propertyKilled', False) for row in mutants)}/2 killed |
| Type diagnostics | {static['baselineTypeErrors']} baseline, {static['currentTypeErrors']} candidate; zero new |
| Lint | Zero new production diagnostics; zero new-test diagnostics |
| Real execution | Authorized HTTP reset and browser reopen of an isolated Billed fixture passed |
| Cleanup | Project containers, volumes and networks removed; production healthy: {cleanup['productionHealthy']} |

Scenario mapping:

1. Billed reset, preserved NetSuite status/quantities/photos/audit, exact retry:
   billed-order-reopen.test.js real HTTP and browser cases.
2. Actual fulfillment IDs, timestamps, quantities and durable fulfillment records,
   Pending Billing and inactive/closed blocks: the same file's negative matrix.
   Existing control-order-reopen suites cover authorization, receiving, posting,
   consolidation, Driver start, stale previews, atomic groups and real lock races.
3. PO action visibility, stale eligibility, execution states, raw metadata,
   mixed selection and ordinary open orders: billed-order-po-link.test.js,
   including fixed-seed two-sided properties and two property-only mutants.
4. Link preview before/after reset: new real HTTP scenario; allocation and split
   correctness: existing dispatch-po-split-link-target.test.js suite.

Known baseline failure, reproduced unchanged:
`{baseline['failures'][0]}`. Its broad `[role="status"]` locator matches both
the reopen result and the application notification status. The existing test
was not weakened or skipped. The new billed-order browser case scopes the
same result assertion to the Order Reopen panel and passes. Static checking
also retains existing diagnostics instead of hiding them.

Initial failures and repairs: both reported behaviors failed before runtime
changes. Two added partial-fulfillment UI cases exposed an incomplete exception;
the exception was tightened without weakening assertions. The first snapshot
fixture targeted a table that does not support SO; the append-only spec correction
documents replacement with the actual durable SO fulfillment table. TypeScript 7
returns 1 for diagnostics; the runner now validates diagnostic output explicitly.

Scope and limits: unrelated module suites were not run. No live order was reset
as a test. Mutation results cover selected plausible regressions, not all possible
faults. The UI property mutations cover UI gating; backend safeguards use concrete
evidence matrices and existing database/concurrency properties. No new capability
or package was added to runtime; dependency audit is not applicable. Source changes
are small expressions, with no new functions or external I/O.

Tools: {json.dumps(final['tools'], sort_keys=True)}; Node {final['node']}.
Logs, browser screenshot, coverage, mutation results and cleanup listings are in
test-artifacts/billed-order-reopen-20261015. Production verification and rollback
are recorded separately by tools/billed-order-reopen-20261015/deploy.py.
"""
(SERVER / 'test/billed-order-reopen-evidence.md').write_text(report)
print(json.dumps({'report': 'server/test/billed-order-reopen-evidence.md', 'newFailures': 0,
                  'changedCoverage': f'{covered}/{total}', 'mutantsKilled': len(mutants)}))
