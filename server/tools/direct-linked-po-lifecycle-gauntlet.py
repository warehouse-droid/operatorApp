"""Run the scoped lifecycle gauntlet entirely in the isolated task database."""
import hashlib
import difflib
import importlib.util
import json
from pathlib import Path
import re
import sys

SERVER = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('lifecycle_runner', SERVER / 'tools/direct-linked-po-lifecycle-run.py')
runner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runner)
TEST = 'test/dispatch/integration/direct-linked-po-lifecycle.test.js'
REPLAY = 'test/dispatch/integration/direct-linked-po-replay.test.js'
SUITES = [TEST, REPLAY,
    'test/dispatch/integration/direct-ship-po-planning.test.js',
    'test/dispatch/integration/direct-ship-to-lifecycle.test.js',
    'test/dispatch/integration/scm-direct-ship-schedule.test.js',
    'test/dispatch/integration/scm-schedule-split-parity.test.js',
    'test/dispatch/integration/scm-po-split-status-consistency.red.test.js',
    'test/dispatch/integration/dispatch-driver-completion-split-isolation.red.test.js',
    'test/dispatch/integration/dispatch-first-split-group-status.test.js',
    'test/dispatch/unit/direct-ship-recorded-projection.test.js',
    'test/dispatch/frontend/scm-schedule-multi-sort.test.js',
    'test/dispatch/frontend/scm-schedule-status-save.test.js']
MIGRATION = 'migrations/256_direct_linked_po_transport_lifecycle.sql'
REPO = 'src/dispatch-repository.js'
MUTANTS = [
 ('pallet', MIGRATION,
  "COALESCE(raw_item_id = 1784 OR upper(btrim(raw_sku)) = 'PALLET', false)",
  'false', 'unlinked pallet deposits'),
 ('overcomplete', MIGRATION,
  ') AND NOT EXISTS (\n    SELECT 1 FROM purchase_order_lines line',
  ') OR NOT EXISTS (\n    SELECT 1 FROM purchase_order_lines line', 'native quantity coverage'),
 ('receipt', MIGRATION,
  "'directShipCoverageVerified'',dispatch_linked_transport_receipt_ready(''PO'',linked_po.ref)",
  "'directShipCoverageVerified'',true", 'native quantity coverage'),
 ('partial', REPO,
  "AND NOT dispatch_linked_transport_delivery_ready('PO', b.order_ref)",
  "AND dispatch_linked_transport_delivery_ready('PO', b.order_ref)", 'delivered linked quantity'),
 ('pickup', REPO,
  'WHEN linked_progress.picked_up', 'WHEN false AND linked_progress.picked_up', 'linked pickup projects'),
 ('fee', MIGRATION,
  "'^split[[:space:]]+pallet[[:space:]]+fee$'", "'^never[[:space:]]+pallet[[:space:]]+fee$'", 'split pallet fees')
]


def remote_write(file, content):
    script = "require('fs').writeFileSync(process.argv[1],require('fs').readFileSync(0))"
    runner.docker('exec', '-i', runner.RUNNER, 'node', '-e', script,
                  runner.REMOTE + '/' + file, input=content.encode())


def mutations():
    results = []
    for name, file, before, after, pattern in MUTANTS:
        original = (SERVER / file).read_text()
        assert original.count(before) == 1, (name, 'unexpected mutation anchor')
        try:
            remote_write(file, original.replace(before, after))
            code = runner.run('mutation-' + name, ['node','--test','--test-concurrency=1',
                '--test-name-pattern=' + pattern, TEST])
            log = (runner.RELEASE / ('mutation-' + name + '.log')).read_text()
            assert code != 0 and re.search(r'^not ok ', log, re.M), name + ' survived'
            assert 'AssertionError' in log or 'Property failed after' in log, name + ' failed on setup instead of behavior'
            results.append({'name': name, 'killed': True, 'testPattern': pattern})
        finally:
            remote_write(file, original)
    (runner.RELEASE / 'mutations.json').write_text(json.dumps(results,indent=2)+'\n')
    return results


def reverse_order():
    bootstrap = "import {readFile} from 'node:fs/promises';import {query,closeDb} from './src/db.js';try{for(const f of ['253_direct_ship_netsuite_posting.sql','256_direct_linked_po_transport_lifecycle.sql'])await query(await readFile('migrations/'+f,'utf8'));}finally{await closeDb();}"
    count = 0
    for index, file in enumerate(reversed(SUITES)):
        # Repository test isolation runs each DB suite on a fresh fixture.
        # The older TO concurrency suite intentionally commits plan fixtures.
        runner.setup(reset=True)
        assert runner.run('reverse-bootstrap-' + str(index), ['node','--input-type=module','-e',bootstrap]) == 0
        label = 'reverse-' + str(index)
        assert runner.run(label, ['node','--test','--test-concurrency=1',file], reset_db=False) == 0
        count += int(re.search(r'^# tests (\d+)$', (runner.RELEASE/(label+'.log')).read_text(), re.M).group(1))
    return count


def baseline_order_dependency():
    files = [REPO, 'src/scm-reconciliation-repository.js']
    base = SERVER/'deployments/direct-ship-schedule-20261002/candidate'
    try:
        for file in files:
            remote_write(file, (base/file).read_text())
        assert runner.run('baseline-order-to', ['node','--test','--test-concurrency=1',
            'test/dispatch/integration/direct-ship-to-lifecycle.test.js']) == 0
        code = runner.run('baseline-order-po', ['node','--test','--test-concurrency=1',
            'test/dispatch/integration/direct-ship-po-planning.test.js'], reset_db=False)
        log = (runner.RELEASE/'baseline-order-po.log').read_text()
        assert code != 0 and 'Dispatch assignment index is still warming up' in log
    finally:
        for file in files:
            remote_write(file, (SERVER/file).read_text())


def coverage():
    runner.setup(reset=True)
    assert runner.run('coverage-final', ['./node_modules/.bin/c8',
        '--include=src/dispatch-repository.js','--include=src/scm-reconciliation-repository.js',
        '--reporter=json','--report-dir=coverage','node','--test','--test-concurrency=1',*SUITES]) == 0
    raw = runner.docker('exec', runner.RUNNER, 'cat', runner.REMOTE+'/coverage/coverage-final.json')
    (runner.RELEASE/'coverage-final.json').write_bytes(raw)
    changes = {}
    base = SERVER/'deployments/direct-ship-schedule-20261002/candidate'
    for file in [REPO,'src/scm-reconciliation-repository.js']:
        old, new = (base/file).read_text().splitlines(), (SERVER/file).read_text().splitlines()
        changes[file] = [line for tag, _, _, start, end in difflib.SequenceMatcher(a=old,b=new).get_opcodes()
                         if tag in ('replace','insert') for line in range(start+1,end+1)]
    script = """const fs=require('fs'),{createCoverageMap}=require('istanbul-lib-coverage');
const changes=JSON.parse(fs.readFileSync(0,'utf8')),map=createCoverageMap(JSON.parse(fs.readFileSync('coverage/coverage-final.json','utf8'))),report={};
for(const [file,lines] of Object.entries(changes)){const cov=map.fileCoverageFor(process.cwd()+'/'+file).getLineCoverage(),executable=lines.filter(line=>Object.hasOwn(cov,line));report[file]={executableLines:executable.length,coveredLines:executable.filter(line=>cov[line]>0).length,uncovered:executable.filter(line=>!cov[line])};}
console.log(JSON.stringify(report));"""
    report = json.loads(runner.docker('exec','-i','-w',runner.REMOTE,runner.RUNNER,'node','-e',script,
                                    input=json.dumps(changes).encode()))
    (runner.RELEASE/'changed-line-coverage.json').write_text(json.dumps(report,indent=2)+'\n')
    assert all(not row['uncovered'] for row in report.values()), report
    return report


def main():
    runner.sync()
    assert runner.run('syntax-dispatch', ['node','--check',REPO]) == 0
    assert runner.run('syntax-reconciliation', ['node','--check','src/scm-reconciliation-repository.js']) == 0
    assert runner.run('lint-final', ['./node_modules/.bin/eslint','--config','eslint.mbt.config.js',
        '--max-warnings=0',TEST,REPLAY]) == 0
    baseline_order_dependency()
    mutants = mutations()
    assert runner.run('validated-final', ['node','--test','--test-concurrency=1',*SUITES]) == 0
    reversed_tests = reverse_order()
    changed_coverage = coverage()
    hashes = {file:hashlib.sha256((SERVER/file).read_bytes()).hexdigest()
        for file in [REPO,'src/scm-reconciliation-repository.js',MIGRATION,TEST,REPLAY,
                     'test/dispatch/fixtures/direct-linked-po-status-cases.json']}
    log = (runner.RELEASE/'validated-final.log').read_text()
    result = {'deployed':False,'liveDataChanged':False,'tests':int(re.search(r'^# tests (\d+)$',log,re.M).group(1)),
        'failures':0,'propertySamples':20,'quantityScenarios':80,'mutantsKilled':len(mutants),
        'syntax':'passed','testLint':'passed','reverseOrderTests':reversed_tests,
        'changedLineCoverage':changed_coverage,'preExistingSharedFixtureOrderIssue':True,'sourceHashes':hashes}
    (runner.RELEASE/'gauntlet-result.json').write_text(json.dumps(result,indent=2)+'\n')
    print(json.dumps(result),flush=True)


if __name__ == '__main__':
    main()
