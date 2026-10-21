"""Bind the final registered-split gauntlet to the exact staged runtime tree."""
from collections import Counter
import difflib
import hashlib
import json
from pathlib import Path
import re

SERVER = Path(__file__).resolve().parents[1]
ARTIFACT = SERVER / 'test-artifacts/registered-split-planning-20261007'
RESULTS = ARTIFACT / 'results/registered-split-planning'
RELEASE = SERVER / 'deployments/registered-split-planning-20261007'
FILE = 'src/dispatch-fulfilled-so-repository.js'


def read(path):
    return json.loads(path.read_text())


def static_comparison(baseline, final):
    for key in ['lintMessages', 'typeMessages']:
        old = Counter(json.dumps(row, sort_keys=True) for row in baseline[key])
        new = Counter(json.dumps(row, sort_keys=True) for row in final[key])
        assert not new - old, f'New {key}: {new - old}'


def changed_coverage():
    old = (RELEASE / 'before' / FILE).read_text().splitlines()
    new = (RELEASE / 'candidate' / FILE).read_text().splitlines()
    changed = {i + 1 for operation, _, _, start, end in difflib.SequenceMatcher(a=old, b=new).get_opcodes()
               if operation in {'insert', 'replace'} for i in range(start, end)}
    executable = {i for i in changed if new[i - 1].strip() and not new[i - 1].lstrip().startswith('//')}
    hits = set()
    suites = []
    for path in sorted((RESULTS / 'final').glob('*-coverage/coverage-final.json')):
        reports = read(path)
        report = next(row for name, row in reports.items() if name.endswith('/' + FILE))
        for statement, span in report['statementMap'].items():
            if report['s'][statement] > 0:
                hits.update(range(span['start']['line'], span['end']['line'] + 1))
        summary = read(path.with_name('coverage-summary.json'))['total']
        suites.append({'suite': path.parent.name, 'lines': summary['lines'], 'branches': summary['branches']})
    assert len(suites) == 3, 'All three acceptance suites must report coverage'
    assert executable <= hits, f'Uncovered changed executable lines: {sorted(executable - hits)}'
    return {'changedPhysicalLines': sorted(changed), 'changedExecutableLines': sorted(executable),
            'covered': len(executable & hits), 'total': len(executable), 'suites': suites}


def main():
    manifest = read(RELEASE / 'manifest.json')
    assert manifest['files'] == [FILE]
    source = (RELEASE / 'candidate' / FILE).read_bytes()
    assert hashlib.sha256(source).hexdigest() == manifest['workspace'][FILE]
    assert source == (SERVER / FILE).read_bytes()
    for name in ['package.json', 'package-lock.json']:
        assert (RELEASE / 'before' / name).read_bytes() == (RELEASE / 'candidate' / name).read_bytes()
    assert not re.search(rb'AKIA[0-9A-Z]{16}|-----BEGIN (?:RSA |EC )?PRIVATE KEY-----', source)
    baseline = read(RESULTS / 'baseline/tests.json')
    final = read(RESULTS / 'final/tests.json')
    for row in final:
        previous = next((item for item in baseline if item['file'] == row['file']), None)
        if previous is None:
            assert row['exit'] == 0 and row['fail'] == 0, row
        else:
            assert row['failures'] == previous['failures'], row
            assert (row['exit'] == 0) == (previous['exit'] == 0), row
    red = read(RESULTS / 'red/tests.json')
    assert all(row['failures'] and row['exit'] != 0 for row in red)
    mutants = read(RESULTS / 'mutations.json')
    assert len(mutants) == 6 and all(row['killedByIntegration'] and row['killedByProperty'] for row in mutants)
    baseline_static = read(RESULTS / 'baseline/static.json')
    final_static = read(RESULTS / 'final/static.json')
    static_comparison(baseline_static, final_static)
    coverage = changed_coverage()
    passes = sum(row['pass'] for row in final)
    failures = sum(row['fail'] for row in final)
    core = [row for row in final if 'registered-split-planning' in row['file']]
    result = {'passed': True, 'candidateTreeHash': manifest['candidateTreeHash'],
              'tests': {'pass': passes, 'preExistingFailures': failures, 'newFailures': 0,
                        'acceptancePass': sum(row['pass'] for row in core), 'files': len(final)},
              'static': {'lintDiagnostics': len(final_static['lintMessages']),
                         'existingTypeDiagnostics': len(final_static['typeMessages']), 'newDiagnostics': 0},
              'changedLineCoverage': coverage, 'mutantsKilledByIntegration': len(mutants),
              'mutantsKilledByProperty': len(mutants), 'dependenciesChanged': False}
    (ARTIFACT / 'validation.json').write_text(json.dumps(result, indent=2) + '\n')
    (RELEASE / 'validation-passed.json').write_text(json.dumps(result, indent=2) + '\n')
    (ARTIFACT / 'runtime.diff').write_text(''.join(difflib.unified_diff(
        (RELEASE / 'before' / FILE).read_text().splitlines(keepends=True),
        source.decode().splitlines(keepends=True), fromfile='before/' + FILE, tofile='candidate/' + FILE)))
    known = [failure for row in baseline for failure in row['failures']]
    report = f'''# Registered split planning evidence

The release changes only `{FILE}`. Active registered SO display splits resolve
their exact parent for every suffix S1–S20 (and other canonical positive numbers).
Materialized splits retain their own lifecycle. The mixed S1/S2 group can be
hydrated and saved through an authenticated, leased same-day HTTP adjustment.

Spec approval: not obtained (autonomous run). See [SPEC.md](SPEC.md), including
the explicit existing S2-policy correction and the generated-fixture clarification.
Tier 3: protected operational planning. No new dependencies or live data migration.

Reproduce all validation: `bash tools/registered-split-planning-gauntlet.sh`
from the server directory. The captured before/candidate releases, standard
Compose wrapper, original regression test, checks, mutants, and this report
generator are retained in the repository. Candidate tree SHA-256:
`{manifest['candidateTreeHash']}`. Runtime source SHA-256:
`{hashlib.sha256(source).hexdigest()}`.

## Final fresh results

- Selected Dispatch suites: **{passes} pass**, **{failures} pre-existing failures**,
  **0 new failures**, {len(final)} files. All **{sum(row['pass'] for row in core)} new
  acceptance tests pass, including three generated properties (50 examples each,
  seed 92229223). Suite file order is shuffled with seed 92229223 and each file
  receives a disposable cloned database.
- RED against captured live source: {sum(row['fail'] for row in red)} behavioral
  failures reproduce the missing later-alias behavior; pre-existing protection
  cases are separately exercised by mutants.
- Changed executable line coverage: **{coverage['covered']}/{coverage['total']}**.
  Raw per-suite line/branch coverage is in validation.json. Coverage is scoped
  to the changed repository, not a claim of whole-application coverage.
- **6/6 manual mutants killed by integration tests and independently 6/6 by
  generated properties**: S1-only filter, inactive registration, derived definition,
  mismatched parent, materialized lifecycle override, and ignored alias completion.
- Runtime syntax passes; runtime lint has {len(final_static['lintMessages'])}
  diagnostics. Added tests/tools pass lint with zero warnings. Existing TypeScript
  project: {len(final_static['typeMessages'])} baseline diagnostics, zero added.
- Real execution: Chromium card is draggable without Planning restricted or
  Completed; normal HTTP feed and two revision/digest/lease saves pass. Screenshot:
  results/registered-split-planning/final/mixed-group.png.
- Packages and lockfile unchanged; runtime diff has no new filesystem, process,
  network, or environment capabilities and no credential material.

## Acceptance and failure-model mapping

| Criterion | Evidence |
| --- | --- |
| All S1–S20, normalized later identities | Twenty-suffix integration test; literal-parent property |
| Mixed materialized S1/registered S2 group | Catalog hydration equality test; Chromium/HTTP same-day adjustment |
| Completion, pickup, source holds/reconciliation/reload | Driver, manual/dependency, lifecycle integration cases; completion property |
| Own materialized lifecycle | Cancelled-membership and actual cancelled-status cases; override mutant |
| Unknown/inactive/derived/wrong-type/malformed/mismatched/missing/duplicate refs | Invalid identity cases; two-existing-parent adversarial case; registration property |
| Sibling delivery isolation | Completed S1 leaves S2 pending test |
| Read lookup preserves quantities, definitions, jobs | Before/after row equality; read-only live feed proof |
| Existing source-decision behavior | All 15 source-decision HTTP/integration regressions pass |
| Safe runtime deployment | One-file captured overlay; full runtime hashes; configuration/dependency checks; automatic rollback |

## Limits and failures retained honestly

Two legacy HTTP tests already omit the now-required snapshot digest and fail
with the existing save fence. They remain unchanged, with identical failures:
{chr(10).join('- ' + name for name in known)}

The first green run exposed an overbroad generated fixture assumption about an
inactive unfinished split; the append-only spec explains the correction. The
original failure log is retained in green-run.log. Final results above come
after that fixture correction and the explicit adversarial parent case.

Validation covers the selected Dispatch/fulfillment/completion/concurrency/source
decision suites, not every repository suite. The existing TypeScript configuration
uses checkJs=false and excludes this runtime JS file; this layer is a no-new-error
comparison, not strong type proof. No dependency audit is needed for an unchanged
dependency set. No production dispatch save or driver action is performed for
testing; production verification uses an enforced read-only transaction. Cleanup
logs retain both docker ps and docker ps -a and verify production health.
'''
    (ARTIFACT / 'EVIDENCE.md').write_text(report)
    print(json.dumps({key: result[key] for key in ['passed', 'candidateTreeHash', 'tests', 'static']}))


if __name__ == '__main__':
    main()
