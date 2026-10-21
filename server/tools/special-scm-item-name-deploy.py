"""Apply the SCM item-name patch to captured live sources and use the existing rollback workflow."""
import datetime
import difflib
import importlib.util
import io
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tarfile
from urllib.parse import urlsplit

SERVER = Path(__file__).resolve().parents[1]
OUT = SERVER / 'test-artifacts/special-workflow-review/scm-item-name-20260930'
FILES = ['src/special-stock-request-domain.js', 'src/special-stock-request-repository.js',
         'public/scm-special-stock-requests.js', 'public/scm-stock-requests.html']
EXISTING = ['test/mbt/unit/special-workflow-review.test.js', 'test/mbt/unit/special-workflow-enquiry.test.js',
            'test/mbt/unit/special-workflow-polish.test.js', 'test/mbt/integration/special-workflow-review.test.js',
            'test/mbt/integration/special-workflow-enquiry.test.js', 'test/mbt/integration/special-batch-save.test.js',
            'test/mbt/integration/special-batch-browser.test.js', 'test/mbt/integration/special-enhancements-http.test.js',
            'test/mbt/unit/special-workflow-documents.test.js', 'test/mbt/unit/special-quote-discount-summary.test.js']
OWN = ['test/mbt/unit/special-scm-item-name.test.js', 'test/mbt/integration/special-scm-item-name.test.js']
spec = importlib.util.spec_from_file_location('quote_release', SERVER / 'tools/special-quote-item-spacing-deploy.py')
workflow = importlib.util.module_from_spec(spec)
spec.loader.exec_module(workflow)
workflow.RELEASE = SERVER / 'deployments/special-scm-item-name-20260930-v2'
workflow.FILES = FILES
workflow.IMAGE = 'mbbs-operator-app:special-scm-item-name-20260930-v2'
workflow.release.RELEASE = workflow.RELEASE
docker, digest, metadata = workflow.docker, workflow.digest, workflow.metadata


def scoped_patch():
    changes = []
    for file in FILES:
        original = (OUT / 'before' / file).read_text()
        updated = (SERVER / file).read_text()
        if file.endswith('.html'):
            original = (workflow.RELEASE / 'before' / file).read_text()
            old = '/scm-special-stock-requests.js?v=20260928-enhancements-v1'
            new = '/scm-special-stock-requests.js?v=20260930-item-name-v1'
            assert original.count(old) == 1 and updated.count(new) == 1
            # Other work is changing regular-stock asset references in this shared file.
            updated = original.replace(old, new)
        changes.extend(difflib.unified_diff(original.splitlines(True), updated.splitlines(True),
                                           fromfile='a/' + file, tofile='b/' + file))
    return ''.join(changes)


def patch_candidate():
    patch = scoped_patch()
    (workflow.RELEASE / 'release.patch').write_text(patch)
    result = subprocess.run(['patch', '--batch', '--fuzz=0', '-p1', '-d', str(workflow.RELEASE / 'candidate')],
                            input=patch, text=True, capture_output=True)
    (workflow.RELEASE / 'patch.log').write_text(result.stdout + result.stderr)
    assert result.returncode == 0, 'Patch requires review'
    for path in (workflow.RELEASE / 'candidate').rglob('*.orig'):
        path.unlink()


def current(data):
    assert metadata(workflow.APP) == data['services']['app']['before'], 'Live app changed since capture'
    assert {name: metadata(name) for name in workflow.DEPENDENCIES} == data['dependencies']
    assert {file: digest((SERVER / file).read_bytes()) for file in FILES} == data['workspaceHashes']
    for file, sha in data['beforeHashes'].items():
        assert digest(docker('exec', workflow.APP, 'cat', '/app/' + file)) == sha
    assert {file: digest((workflow.RELEASE / 'candidate' / file).read_bytes()) for file in FILES} == data['sourceHashes']


def capture():
    os.umask(0o077)
    workflow.RELEASE.mkdir(exist_ok=False)
    before = metadata(workflow.APP)
    data = {'services': {'app': {'before': before, 'image': workflow.IMAGE}},
            'dependencies': {name: metadata(name) for name in workflow.DEPENDENCIES},
            'workspaceHashes': {file: digest((SERVER / file).read_bytes()) for file in FILES}}
    baseline = workflow.RELEASE / 'before'
    baseline.mkdir()
    for folder in ['src', 'public', 'migrations']:
        with tarfile.open(fileobj=io.BytesIO(docker('cp', workflow.APP + ':/app/' + folder, '-'))) as archive:
            archive.extractall(baseline, filter='data')
    for file in ['package.json', 'package-lock.json']:
        (baseline / file).write_bytes(docker('exec', workflow.APP, 'cat', '/app/' + file))
    assert metadata(workflow.APP) == before
    candidate = workflow.RELEASE / 'candidate'
    shutil.copytree(baseline, candidate)
    patch_candidate()
    candidate_files, baseline_files = workflow.release.files_at(candidate), workflow.release.files_at(baseline)
    changed = sorted(file for file in candidate_files if candidate_files[file] != baseline_files.get(file))
    assert changed == sorted(FILES), 'Unexpected source scope'
    data['beforeHashes'] = {file: digest((baseline / file).read_bytes()) for file in FILES}
    data['sourceHashes'] = {file: digest((candidate / file).read_bytes()) for file in FILES}
    current(data)
    workflow.save('manifest.json', data)
    print(json.dumps({'captured': True, 'changedFiles': changed}), flush=True)


def test_candidate(data):
    runner = json.loads(docker('inspect', 'mbbs-special-review-runner'))[0]
    env = dict(value.split('=', 1) for value in runner['Config']['Env'])
    assert env['MBT_TEST_ISOLATED'] == '1' and env['NETSUITE_DIRECT_ACCESS_ENABLED'] == 'false'
    database = urlsplit(env['DATABASE_URL'])
    assert database.hostname == 'mbbs-special-review-db'
    env.update(DATABASE_URL=database._replace(path='/mbt_verify').geturl(), PLAYWRIGHT_BROWSERS_PATH='/browsers')
    def run(label, directory, tests, extra):
        name = 'mbbs-special-review-runner'
        root = '/tmp/special-scm-item-name-v2-' + label
        docker('exec', name, 'node', '-e', "const fs=require('fs');fs.rmSync(process.argv[1],{recursive:true,force:true});fs.mkdirSync(process.argv[1]);", root)
        docker('cp', str(directory) + '/.', name + ':' + root)
        docker('exec', name, 'node', '-e', "const fs=require('fs'),root=process.argv[1];for(const folder of ['test','tools'])fs.cpSync('/app/'+folder,root+'/'+folder,{recursive:true});fs.symlinkSync('/app/node_modules',root+'/node_modules','dir');", root)
        if label == 'candidate-baseline':
            for file in ['test/mbt/integration/special-batch-browser.test.js', 'test/mbt/integration/special-enhancements-http.test.js']:
                docker('cp', str(OUT / 'before' / file), name + ':' + root + '/' + file)
        args = ['sudo', '-n', 'docker', 'exec']
        for key, value in env.items():
            args += ['-e', key + '=' + value]
        args += ['-e', 'SPECIAL_BATCH_BROWSER_OUTPUT=/app/test-artifacts/special-workflow-review/scm-item-name-20260930/' + label]
        args += ['-w', root, name, 'node', '--test', '--test-concurrency=1', *extra, *tests]
        with (workflow.RELEASE / (label + '.log')).open('wb') as log:
            result = subprocess.run(args, stdout=log, stderr=subprocess.STDOUT, timeout=180)
        output = (workflow.RELEASE / (label + '.log')).read_text()
        failures = re.findall(r'^not ok \d+ - (.+)$', output, re.M)
        assert result.returncode == 0 or result.returncode == 1 and failures, output[-5000:]
        assert 'hookFailed' not in output and 'ERR_MODULE_NOT_FOUND' not in output, 'Candidate runner setup failed'
        assert not any(name.startswith('/') for name in failures), 'A candidate suite failed to load'
        docker('exec', name, 'node', '-e', "require('fs').rmSync(process.argv[1],{recursive:true,force:true});", root)
        return {'exitCode': result.returncode, 'failures': failures,
                **{key: int(re.search(r'^# ' + key + r' (\d+)$', output, re.M).group(1)) for key in ['tests', 'pass', 'fail']}}
    baseline = run('candidate-baseline', workflow.RELEASE / 'before', EXISTING, [])
    candidate = run('candidate-regressions', workflow.RELEASE / 'candidate', EXISTING + OWN, [])
    assert candidate['tests'] >= 67, 'All affected suites and new acceptance tests must run'
    assert not [name for name in candidate['failures'] if name not in baseline['failures']], candidate
    workflow.save('candidate-checks.json', {'baseline': baseline, 'candidate': candidate, 'newFailures': []})
    print(json.dumps({'candidateTests': candidate['tests'], 'candidatePassed': candidate['pass'],
                      'baselineFailures': len(baseline['failures']), 'newFailures': []}), flush=True)


def prepare():
    data = workflow.state()
    checks = json.loads((OUT / 'checks.json').read_text())
    assert checks['completed'] and not checks['newFailures'] and checks['mutantsKilled'] == 6
    assert checks['sourceHashes'] == data['workspaceHashes']
    coverage = json.loads((OUT / 'coverage-result.json').read_text())
    assert not coverage['uncovered'] and not coverage['branches']['uncovered']
    current(data)
    test_candidate(data)
    stage = workflow.RELEASE / 'stage'
    for file in FILES:
        target = stage / 'overlay' / file
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(workflow.RELEASE / 'candidate' / file, target)
    before = data['services']['app']['before']
    assert docker('image', 'inspect', '--format', '{{.Id}}', before['image']).decode().strip() == before['imageId']
    (stage / 'Dockerfile').write_text('FROM ' + before['image'] + '\nCOPY --chown=node:node overlay/ /app/\n')
    with (workflow.RELEASE / 'build.log').open('wb') as log:
        subprocess.run(['sudo', '-n', 'docker', 'build', '--network', 'none', '--pull=false',
                        '-t', workflow.IMAGE, str(stage)], stdout=log, stderr=subprocess.STDOUT, check=True)
    data['services']['app']['candidateImageId'] = docker('image', 'inspect', '--format', '{{.Id}}', workflow.IMAGE).decode().strip()
    expected = json.loads(docker('exec', workflow.APP, 'node', '-e', workflow.HASH_SCRIPT))
    expected.update(data['sourceHashes'])
    assert json.loads(docker('run', '--rm', '--network', 'none', '--entrypoint', 'node', workflow.IMAGE,
                            '-e', workflow.HASH_SCRIPT)) == expected
    workflow.save('source-tree.json', expected)
    docker('run', '--rm', '--network', 'none', '-e', 'MBBS_ENV_FILE=/nonexistent',
           '-e', 'NETSUITE_DIRECT_ACCESS_ENABLED=false', '-e', 'NETSUITE_MIRROR_ROLE=disabled',
           '--entrypoint', 'node', workflow.IMAGE, '--input-type=module', '-e',
           "await import('./src/server.js');process.exit(0)")
    (workflow.RELEASE / 'compose.release.yml').write_text('services:\n  app:\n    image: ' + workflow.IMAGE + '\n')
    (workflow.RELEASE / 'compose.rollback.yml').write_text('services:\n  app:\n    image: ' + before['imageId'] + '\n')
    workflow.release.config_check(data)
    current(data)
    workflow.save('manifest.json', data)
    print(json.dumps({'prepared': True}), flush=True)


def verify():
    data = workflow.state()
    workflow.release.core.ready(data['services']['app']['candidateImageId'])
    after = metadata(workflow.APP)
    assert after['imageId'] == data['services']['app']['candidateImageId']
    assert after['configuration'] == data['services']['app']['before']['configuration']
    assert {name: metadata(name) for name in workflow.DEPENDENCIES} == data['dependencies']
    assert json.loads(docker('exec', workflow.APP, 'node', '-e', workflow.HASH_SCRIPT)) == json.loads(
        (workflow.RELEASE / 'source-tree.json').read_text())
    script = r"""import assert from 'node:assert/strict';import crypto from 'node:crypto';
import {normalizeSpecialSupplyResponse} from './src/special-stock-request-domain.js';
assert.equal(normalizeSpecialSupplyResponse({productName:' Corrected item ',supplyStatus:'in_stock',availabilityMode:'no_projection',vendorId:330,vendorName:'BWS',vendorYard:'Yard'}).productName,'Corrected item');
const hashes=HASHES;
for(const [file,sha] of Object.entries(hashes)){
 if(!file.startsWith('public/'))continue;
 const path=file.endsWith('.html')?'/scm/stock-requests':'/'+file.slice(7);
 const response=await fetch('https://test.mbbsoperation.com'+path,{headers:{'User-Agent':'Mozilla/5.0','Cache-Control':'no-cache'}});assert.equal(response.status,200);
 const body=(await response.text()).replace(/<script type="module" src="https:\/\/static\.cloudflareinsights\.com\/beacon\.min\.js\/[^>]+><\/script>\n/g,'');
 assert.equal(crypto.createHash('sha256').update(body).digest('hex'),sha,file);
}
const response=await fetch('https://test.mbbsoperation.com/health');assert.equal(response.status,200);assert.equal((await response.json()).ok,true);
console.log(JSON.stringify({health:true,publicAssets:true,itemNameNormalization:true}));"""
    live = json.loads(docker('exec', '-i', workflow.APP, 'node', '--input-type=module',
                            input=script.replace('HASHES', json.dumps(data['sourceHashes'])).encode()))
    result = {'deployed': True, 'at': datetime.datetime.now(datetime.timezone.utc).isoformat(),
              'image': workflow.IMAGE, 'changedFiles': FILES, 'live': live}
    workflow.save('result.json', result)
    print(json.dumps(result), flush=True)


workflow.current = current
workflow.verify = verify
if __name__ == '__main__':
    {'capture': capture, 'prepare': prepare, 'test': lambda: test_candidate(workflow.state()),
     'apply': workflow.apply, 'verify': verify}[sys.argv[1]]()
