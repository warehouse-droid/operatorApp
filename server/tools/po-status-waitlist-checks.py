"""Validate the combined frozen release using separate isolated databases."""
import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import sys

SERVER = Path(__file__).resolve().parents[1]


def load(name, file):
    spec = importlib.util.spec_from_file_location(name, SERVER / 'tools' / file)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


release = load('combined_validation_release', 'po-status-waitlist-deploy.py')
po = load('combined_po_runner', 'direct-linked-po-lifecycle-run.py')
waitlist = load('combined_waitlist_runner', 'regular-waitlist-run.py')
gauntlet = load('combined_po_suites', 'direct-linked-po-lifecycle-gauntlet.py')
po.RELEASE = release.RELEASE
po.DATABASE_NAME = 'po_status_waitlist_20261002'
po.REMOTE = '/tmp/po-status-waitlist-20261002'
waitlist.OUT = release.RELEASE
waitlist.REMOTE = '/tmp/po-status-waitlist-20261002'


def stage():
    data = release.state()
    release.current(data)
    source = release.RELEASE / 'validation-candidate'
    shutil.copytree(release.RELEASE / 'candidate', source)
    frozen_po = SERVER / 'deployments/direct-linked-po-lifecycle-20261002/validation-workspace'
    frozen_waitlist = SERVER / 'deployments/regular-waitlist-enhancements-20261002/validation-candidate'
    shutil.copytree(frozen_po / 'test', source / 'test')
    shutil.copytree(frozen_waitlist / 'tools', source / 'tools', ignore=shutil.ignore_patterns('__pycache__'))
    for group in ['unit', 'property', 'integration', 'adversarial']:
        for file in (frozen_waitlist / 'test/mbt' / group).glob('regular-waitlist*.test.js'):
            shutil.copy2(file, source / 'test/mbt' / group / file.name)
    shutil.copy2(frozen_waitlist / 'test/support/regular-waitlist-list-harness.mjs', source / 'test/support')
    shutil.copy2(frozen_po / 'eslint.mbt.config.js', source)
    shutil.copy2(frozen_waitlist / 'netsuite-smart-scm-picking-ticket-restlet.js', source)
    shutil.copy2(SERVER / 'deployments/direct-linked-po-lifecycle-20261002/test-database-fixture.sql', release.RELEASE)
    assert release.files_at(source) == data['sourceTree']
    po.test_environment()
    row = json.loads(release.docker('inspect', waitlist.RUNNER))[0]
    env = dict(value.split('=', 1) for value in row['Config']['Env'])
    assert env['MBT_TEST_ISOLATED'] == '1' and env['NETSUITE_DIRECT_ACCESS_ENABLED'] == 'false'
    assert '@db:5432/mbt_test' in env['DATABASE_URL'] and waitlist.NETWORK in row['NetworkSettings']['Networks']
    assert json.loads(release.docker('network', 'inspect', waitlist.NETWORK))[0]['Internal']
    for runner in [po.RUNNER, waitlist.RUNNER]:
        release.docker('exec', runner, 'node', '-e', "const fs=require('fs'),p=process.argv[1];if(fs.existsSync(p))throw Error('Preserve existing validation source');fs.mkdirSync(p)", po.REMOTE)
        release.docker('cp', str(source) + '/.', runner + ':' + po.REMOTE)
        release.docker('exec', runner, 'node', '-e', "require('fs').symlinkSync('/app/node_modules',process.argv[1]+'/node_modules','dir')", po.REMOTE)
    print(json.dumps({'combinedSourcesFrozen': True, 'isolatedRunners': 2}), flush=True)


def record(label, code):
    log = (release.RELEASE / (label + '.log')).read_text()
    waitlist_count = re.search(r'^Isolated focused waitlist run passed: \d+ file\(s\), (\d+) test\(s\)\.$', log, re.M)
    count = int(waitlist_count.group(1)) if waitlist_count else sum(int(n) for n in re.findall(r'^# tests (\d+)$', log, re.M))
    result = {'label': label, 'exitCode': code, 'tests': count}
    release.save(label + '-result.json', result)
    assert code == 0, label + ' failed'
    return result


def po_tests():
    po.setup(reset=True)
    bootstrap = "import{readFile}from'node:fs/promises';import{query,closeDb}from'./src/db.js';try{for(const f of ['253_direct_ship_netsuite_posting.sql','256_direct_linked_po_transport_lifecycle.sql'])await query(await readFile('migrations/'+f,'utf8'));}finally{await closeDb();}"
    assert po.run('po-bootstrap', ['node', '--input-type=module', '-e', bootstrap]) == 0
    print(json.dumps(record('po-regressions', po.run('po-regressions', ['node', '--test', '--test-concurrency=1', *gauntlet.SUITES], reset_db=False))), flush=True)


def waitlist_tests():
    assert waitlist.run('waitlist-schema', ['node', 'src/migrate.js']) == 0
    for label, options in [('waitlist-focused', []), ('waitlist-shuffled', ['--shuffle'])]:
        print(json.dumps(record(label, waitlist.run(label, ['node', 'tools/regular-waitlist-focused.mjs', '--no-coverage', *options]))), flush=True)


def syntax():
    code = "const fs=require('fs'),{execFileSync}=require('child_process');let checked=0;for(const file of " + json.dumps(release.FILES) + ")if(file.endsWith('.js')){execFileSync(process.execPath,['--check',file]);checked++}console.log(JSON.stringify({syntax:true,checked}));"
    assert po.run('syntax', ['node', '-e', code]) == 0
    record('syntax', 0)


def finish():
    data = release.state()
    labels = ['po-regressions', 'waitlist-focused', 'waitlist-shuffled', 'syntax']
    results = [record(label, json.loads((release.RELEASE / (label + '-result.json')).read_text())['exitCode']) for label in labels]
    assert all(row['exitCode'] == 0 for row in results)
    assert [row['tests'] for row in results[:3]] == [118, 63, 63]
    release.save('candidate-checks.json', {'sourceHashes': data['sourceHashes'], 'results': results})
    release.validated(data)
    print(json.dumps({'combinedChecksPassed': True, 'poTests': 118, 'waitlistTests': 63, 'shuffledWaitlistTests': 63}), flush=True)


if __name__ == '__main__':
    os.umask(0o077)
    {'stage': stage, 'po-tests': po_tests, 'waitlist-tests': waitlist_tests, 'syntax': syntax, 'finish': finish}[sys.argv[1]]()
