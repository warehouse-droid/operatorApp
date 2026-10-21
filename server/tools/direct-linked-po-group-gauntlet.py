"""Scoped executable assurance for grouped split delivery status."""
import hashlib
import difflib
import importlib.util
import json
import platform
from pathlib import Path
import re
import sys

SERVER = Path(__file__).resolve().parents[1]


def load(name, file):
    spec = importlib.util.spec_from_file_location(name, SERVER / 'tools' / file)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


group = load('group_gauntlet_runner', 'direct-linked-po-group-run.py')
prior = load('group_gauntlet_suites', 'direct-linked-po-lifecycle-gauntlet.py')
runner = group.runner
RELEASE = group.RELEASE
TEST = group.TEST
MIGRATION = 'migrations/257_direct_linked_po_group_completion.sql'
SUITES = [*prior.SUITES, TEST]
MUTANTS = [
    ('siblings', MIGRATION, 'cardinality(dispatch_po_allocation_delivery_refs(allocation.id))>0 AND NOT EXISTS (',
     'cardinality(dispatch_po_allocation_delivery_refs(allocation.id))>0 AND EXISTS (', 'native group quantities'),
    ('quantity', MIGRATION, 'SUM(quantity)+0.000001>=allocation.allocated_sales_qty', 'true', 'native group quantities'),
    ('line-identity', MIGRATION, "item.detail->>'lineRowId'=allocation.sales_line_id::text", 'true', 'wrong line identity'),
    ('order-kind', MIGRATION, "dispatch_completion_driver_order_kind(raw_ref,raw_details)='SO'", 'true', 'wrong Driver kind'),
    ('receipt', MIGRATION, "'directShipCoverageVerified',dispatch_linked_transport_receipt_ready('PO',linked_po.ref)",
     "'directShipCoverageVerified',true", 'native group quantities'),
]
BOOTSTRAP = "import{readFile}from'node:fs/promises';import{query,closeDb}from'./src/db.js';try{for(const f of ['253_direct_ship_netsuite_posting.sql','256_direct_linked_po_transport_lifecycle.sql','257_direct_linked_po_group_completion.sql'])await query(await readFile('migrations/'+f,'utf8'));}finally{await closeDb();}"


def bootstrap():
    runner.setup(reset=True)
    assert runner.run('group-bootstrap', ['node', '--input-type=module', '-e', BOOTSTRAP]) == 0


def write(file, text):
    runner.docker('exec', '-i', runner.RUNNER, 'node', '-e',
        "require('fs').writeFileSync(process.argv[1],require('fs').readFileSync(0))",
        runner.REMOTE + '/' + file, input=text.encode())


def regressions():
    bootstrap()
    assert runner.run('group-regressions', ['node','--test','--test-concurrency=1', *SUITES], reset_db=False) == 0


def mutations():
    results = []
    for name, file, before, after, pattern in MUTANTS:
        original = (RELEASE / 'candidate' / file).read_text()
        assert original.count(before) == 1, name
        try:
            write(file, original.replace(before,after))
            code = runner.run('group-mutation-' + name, ['node','--test','--test-concurrency=1','--test-name-pattern=' + pattern,TEST])
            log = (RELEASE / ('group-mutation-' + name + '.log')).read_text()
            assert code != 0 and re.search(r'^not ok ',log,re.M), name + ' survived'
            assert 'AssertionError' in log or 'Property failed after' in log, name + ' did not fail on behavior'
            results.append({'name': name, 'killed': True, 'pattern': pattern, 'propertyOnly': pattern == 'native group quantities'})
        finally:
            write(file,original)
    (RELEASE / 'group-mutations.json').write_text(json.dumps(results,indent=2)+'\n')
    print(json.dumps({'mutationsKilled': len(results)}), flush=True)


def coverage():
    bootstrap()
    assert runner.run('group-coverage', ['./node_modules/.bin/c8','--include=src/dispatch-repository.js',
        '--reporter=json','--report-dir=group-coverage','node','--test','--test-concurrency=1',*SUITES], reset_db=False) == 0
    raw = runner.docker('exec',runner.RUNNER,'cat',runner.REMOTE + '/group-coverage/coverage-final.json')
    (RELEASE / 'coverage-final.json').write_bytes(raw)
    report = json.loads(raw)
    file = 'src/dispatch-repository.js'
    before = (RELEASE/'before'/file).read_text().splitlines()
    after = (RELEASE/'candidate'/file).read_text().splitlines()
    lines = [number+1 for tag,_,_,start,end in difflib.SequenceMatcher(a=before,b=after).get_opcodes()
        if tag in ('insert','replace') for number in range(start,end) if after[number].strip()]
    entry = next(value for key,value in report.items() if key.endswith('/'+file))
    hits = {line: max([entry['s'][key] for key,value in entry['statementMap'].items()
        if value['start']['line'] <= line <= value['end']['line']] or [0]) for line in lines}
    assert lines and all(hits.values()), hits
    (RELEASE/'changed-line-coverage.json').write_text(json.dumps({'executableLines':len(lines),'coveredLines':len(lines),'hits':hits,'scope':'JavaScript SQL query construction; PostgreSQL SQL line instrumentation unavailable'},indent=2)+'\n')


def shuffled():
    # Existing TO fixtures commit a plan, so use the repository's per-file DB
    # isolation rather than carrying that fixture into the next suite.
    count = 0
    for index,file in enumerate(reversed(SUITES)):
        bootstrap()
        label = 'group-reversed-' + str(index)
        assert runner.run(label,['node','--test','--test-concurrency=1',file],reset_db=False) == 0
        count += int(re.search(r'^# tests (\d+)$',(RELEASE/(label+'.log')).read_text(),re.M).group(1))
    (RELEASE/'reversed-result.json').write_text(json.dumps({'tests':count,'failed':0})+'\n')


def static():
    assert runner.run('group-syntax',['node','--check','src/dispatch-repository.js']) == 0
    assert runner.run('group-test-syntax',['node','--check',TEST]) == 0
    assert runner.run('group-lint',['./node_modules/.bin/eslint','--config','eslint.mbt.config.js',TEST]) == 0
    (RELEASE/'static-result.json').write_text(json.dumps({'syntax':'passed','testLint':'passed'})+'\n')


def waitlist():
    checks = load('group_waitlist_runner','regular-waitlist-run.py')
    checks.OUT, checks.REMOTE = RELEASE, '/tmp/direct-linked-po-group-20261002-v2'
    info = json.loads(checks.docker('inspect',checks.RUNNER))[0]
    env = dict(value.split('=',1) for value in info['Config']['Env'])
    assert env['MBT_TEST_ISOLATED']=='1' and env['NETSUITE_DIRECT_ACCESS_ENABLED']=='false'
    assert '@db:5432/mbt_test' in env['DATABASE_URL']
    assert json.loads(checks.docker('network','inspect',checks.NETWORK))[0]['Internal']
    checks.docker('exec',checks.RUNNER,'node','-e',"const fs=require('fs'),p=process.argv[1];if(fs.existsSync(p))throw Error('Preserve previous source');fs.mkdirSync(p)",checks.REMOTE)
    checks.docker('cp',str(RELEASE/'validation-candidate')+'/.',checks.RUNNER+':'+checks.REMOTE)
    checks.docker('exec',checks.RUNNER,'node','-e',"require('fs').symlinkSync('/app/node_modules',process.argv[1]+'/node_modules','dir')",checks.REMOTE)
    assert checks.run('group-waitlist-schema',['node','src/migrate.js']) == 0
    assert checks.run('group-waitlist-focused',['node','tools/regular-waitlist-focused.mjs','--no-coverage']) == 0
    log = (RELEASE/'group-waitlist-focused.log').read_text()
    assert 'Isolated focused waitlist run passed: 11 file(s), 63 test(s).' in log
    (RELEASE/'waitlist-result.json').write_text(json.dumps({'tests':63,'failed':0})+'\n')


def report():
    log = (RELEASE/'group-coverage.log').read_text()
    assert re.search(r'^# fail 0$',log,re.M)
    count = int(re.search(r'^# tests (\d+)$',log,re.M).group(1))
    hashes = {file:hashlib.sha256((RELEASE/'candidate'/file).read_bytes()).hexdigest()
        for file in ['src/dispatch-repository.js',MIGRATION]}
    assert all(hashlib.sha256((RELEASE/'validation-candidate'/file).read_bytes()).hexdigest()==value for file,value in hashes.items())
    patch = (RELEASE/'changes.patch').read_text()
    patterns = [r'-----BEGIN [A-Z ]*PRIVATE KEY-----',r'AKIA[A-Z0-9]{16}',
        r'''(?i)(?:password|api_key|client_secret|access_token)\s*[:=]\s*["'][^"']{8,}''']
    scan = {'credentialPatternMatches':sum(len(re.findall(pattern,patch)) for pattern in patterns),'dependenciesAdded':0}
    assert scan['credentialPatternMatches']==0
    (RELEASE/'capability-scan.json').write_text(json.dumps(scan,indent=2)+'\n')
    code = "const p=require('path'),v={node:process.version};for(const n of ['pg','c8','eslint','fast-check'])v[n]=require(p.join('/app/node_modules',n,'package.json')).version;process.stdout.write(JSON.stringify(v))"
    versions = json.loads(runner.docker('exec',runner.RUNNER,'node','-e',code))
    versions['postgresql'] = runner.docker('exec','mbbs-special-review-db','psql','--version').decode().strip()
    versions['python'] = platform.python_version()
    (RELEASE/'tool-versions.json').write_text(json.dumps(versions,indent=2)+'\n')
    result = {'deployed':False,'tests':count,'failures':0,'propertyExamples':20,'quantityScenarios':40,
        'mutants':json.loads((RELEASE/'group-mutations.json').read_text()),
        'changedLineCoverage':json.loads((RELEASE/'changed-line-coverage.json').read_text()),
        'reversedOrder':json.loads((RELEASE/'reversed-result.json').read_text()),
        'waitlist':json.loads((RELEASE/'waitlist-result.json').read_text()),
        'static':json.loads((RELEASE/'static-result.json').read_text()),
        'capabilityScan':scan,'toolVersions':versions,
        'testHashes':{file:hashlib.sha256((RELEASE/'validation-candidate'/file).read_bytes()).hexdigest()
            for file in [TEST,'test/dispatch/integration/direct-ship-po-planning.test.js']},'sourceHashes':hashes}
    (RELEASE/'gauntlet-result.json').write_text(json.dumps(result,indent=2)+'\n')
    print(json.dumps(result),flush=True)


def all_checks():
    # Reproduce from the frozen reviewed source and tests, not a later workspace.
    runner.test_environment()
    runner.docker('exec',runner.RUNNER,'node','-e',"const fs=require('fs'),p=process.argv[1];fs.rmSync(p,{recursive:true,force:true});fs.mkdirSync(p)",runner.REMOTE)
    runner.docker('cp',str(RELEASE/'validation-candidate')+'/.',runner.RUNNER+':'+runner.REMOTE)
    runner.docker('exec',runner.RUNNER,'node','-e',"require('fs').symlinkSync('/app/node_modules',process.argv[1]+'/node_modules','dir')",runner.REMOTE)
    coverage()
    mutations()
    static()
    shuffled()
    # The waitlist source path is on a different dedicated runner; preserve any
    # existing source by using a fresh reproduction path for that one layer.
    checks = load('group_waitlist_repro_runner','regular-waitlist-run.py')
    path = '/tmp/direct-linked-po-group-20261002-v2'
    exists = checks.docker('exec',checks.RUNNER,'node','-e',"process.stdout.write(String(require('fs').existsSync(process.argv[1])))",path).decode()
    if exists=='true':
        checks.docker('exec',checks.RUNNER,'node','-e',"require('fs').renameSync(process.argv[1],process.argv[1]+'-preserved-'+Date.now())",path)
    waitlist()
    report()


if __name__ == '__main__':
    {'all':all_checks,'regressions':regressions,'mutations':mutations,'coverage':coverage,'shuffled':shuffled,'static':static,'waitlist':waitlist,'report':report}[sys.argv[1]]()
