"""Compare the fix against production and record reproducible release evidence."""
from collections import Counter
import difflib
import json
from pathlib import Path
import re
import subprocess
import sys

SERVER = Path(__file__).resolve().parents[1]
ARTIFACT = SERVER / 'test-artifacts'
RELEASE = ARTIFACT / 'dispatch-special-po-deployment-20260925'
CHECKS = ARTIFACT / 'dispatch-special-po-lifecycle/checks'


def log(name):
    return (ARTIFACT / ('dispatch-special-po-' + name + '.log')).read_text()


def counts(value):
    return {key: sum(map(int, re.findall(r'^(?:ℹ |# )' + key + r' (\d+)$', value, re.M)))
            for key in ['tests', 'pass', 'fail', 'skipped', 'cancelled']}


def failures(value):
    return sorted(set(re.findall(r'^✖ (.+?) \([\d.]+ms\)$', value, re.M)))


def failed_files(value):
    files, current = set(), None
    for line in value.splitlines():
        match = re.match(r'\[isolation\].+ (/app/\S+)', line)
        if match:
            current = match.group(1).removeprefix('/app/')
        if line.startswith('✖ ') and line != '✖ failing tests:':
            assert current
            files.add(current)
    return sorted(files)


def replay():
    files = failed_files(log('full-mbt'))
    script = """import path from 'node:path';
import {query,closeDb} from './src/db.js';
import {buildIsolatedTestEnvironment} from './test/support/test-foundation.mjs';
import {runNodeTestFilesIsolated} from './test/support/test-database-isolation.mjs';
const files=process.argv.slice(1);
if(files.includes('test/mbt/integration/stock-return-draft-insert.test.js')) {
  await query("UPDATE return_reason_cache SET fetched_at=now()-interval '2 days'");
}
await closeDb();
process.exitCode=await runNodeTestFilesIsolated(files.map(file=>path.resolve(file)),{
  environment:buildIsolatedTestEnvironment(process.env,{databaseUrl:process.env.DATABASE_URL}),label:'Production baseline replay'});
"""
    command = ['sudo', '-n', 'env', 'SPECIAL_PO_CHECK=baseline-full',
               'SPECIAL_PO_SOURCE_ROOT=' + str(RELEASE / 'baseline'),
               'bash', str(SERVER / 'tools/dispatch-special-po-test.sh'),
               'node', '--input-type=module', '-e', script, *files]
    with (ARTIFACT / 'dispatch-special-po-baseline-full.log').open('wb') as output:
        result = subprocess.run(command, cwd=SERVER, stdout=output, stderr=subprocess.STDOUT)
    print(json.dumps({'baselineFailedFiles': files, 'exitCode': result.returncode,
                      'stockReturnCacheAgedToMatchLongFullRun': 'test/mbt/integration/stock-return-draft-insert.test.js' in files,
                      'counts': counts(log('baseline-full'))}), flush=True)


def diagnostics():
    def lint(file):
        return Counter((row['filePath'], message['ruleId'], message['message'])
                       for row in json.loads(file.read_text()) for message in row['messages'])
    def types(file):
        return Counter(re.sub(r'\(\d+,\d+\)', '', line) for line in file.read_text().splitlines())
    result = {}
    for name, parse in [('lint', lint), ('types', types)]:
        baseline = parse(CHECKS / 'baseline-static' / (name + '.log'))
        candidate = parse(CHECKS / 'final-layers' / (name + '.log'))
        assert not candidate - baseline, (name, candidate - baseline)
        result[name] = {'existingDiagnostics': sum(candidate.values()), 'newDiagnostics': 0}
    return result


def coverage():
    source = json.loads((CHECKS / 'final-layers/coverage/coverage-final.json').read_text())
    result = []
    for file in ['src/dispatch-po-route-projection.js', 'src/dispatch-history-mode.js', 'src/dispatch-completion-repository.js']:
        before = (RELEASE / 'baseline' / file).read_text().splitlines()
        after = (SERVER / file).read_text().splitlines()
        changed = set()
        for tag, _, _, start, end in difflib.SequenceMatcher(a=before, b=after).get_opcodes():
            if tag in ['insert', 'replace']:
                changed.update(range(start + 1, end + 1))
        data, hits = source['/app/' + file], {}
        for key, pos in data['statementMap'].items():
            for line in range(pos['start']['line'], pos['end']['line'] + 1):
                hits[line] = max(hits.get(line, 0), data['s'][key])
        changed = {n for n in changed if after[n - 1].strip() and not after[n - 1].lstrip().startswith('//')}
        missing = sorted(n for n in changed if not hits.get(n, 0))
        assert not missing, (file, missing)
        result.append({'file': file, 'changedLines': len(changed), 'covered': len(changed)})
    return result


def check():
    assert re.search(r'Isolated MBT main run (?:failed in \d+/604 file\(s\)|passed)', log('full-mbt')), 'Full suite still running'
    baseline_related = set(failures(log('baseline-related')))
    baseline_full = set(failures(log('baseline-full')))
    assert not set(failures(log('related'))) - baseline_related, 'New related failure'
    assert set(failures(log('random'))) == set(failures(log('related'))), 'Order-dependent related suite'
    assert not set(failures(log('full-mbt'))) - baseline_full, 'New full-suite failure'
    mutations = json.loads((CHECKS / 'final-layers/mutations.json').read_text())
    assert len(mutations) == 7 and all(row['killed'] for row in mutations)
    assert sum(row['propertyKilled'] is True for row in mutations) == 4
    summary = json.loads((CHECKS / 'final-layers/coverage/coverage-summary.json').read_text())
    route = summary['/app/src/dispatch-po-route-projection.js']
    assert route['lines']['pct'] == 100
    assert counts((CHECKS / 'final-layers/coverage.log').read_text())['fail'] == 0
    assert (CHECKS / 'final-layers/secrets.log').exists()
    manifest = json.loads((RELEASE / 'manifest.json').read_text())
    assert sorted(manifest['runtimeChanges']) == sorted([
        'src/dispatch-po-route-projection.js', 'src/dispatch-history-mode.js',
        'src/dispatch-completion-repository.js', 'migrations/213_dispatch_special_po_link_coverage.sql'])
    result = {'passed': True, 'sourceTreeHash': manifest['sourceTreeHash'],
              'fullSuite': counts(log('full-mbt')), 'relatedSuite': counts(log('related')),
              'randomizedSuite': counts(log('random')), 'newTestFailures': 0,
              'knownFullFailures': sorted(baseline_full), 'knownRelatedFailures': sorted(baseline_related),
              'mutationKilled': len(mutations), 'propertyMutationsKilled': 4,
              'changedCoverage': coverage(), 'routeCoverage': route, 'staticChecks': diagnostics()}
    (RELEASE / 'release-checks.json').write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps(result), flush=True)


if __name__ == '__main__':
    {'replay': replay, 'check': check}[sys.argv[1]]()
