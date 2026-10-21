"""Build and release only the four validated PO status files over the captured live app."""
import datetime
import difflib
import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile

SERVER = Path(__file__).resolve().parents[1]
RELEASE = SERVER / 'deployments/scm-status-parity-20261001'
OUT = SERVER / 'test-artifacts/scm-status-parity-20261001'
APP = 'mbbs-operator-app-app-1'
FILES = ['src/dispatch-repository.js', 'src/scm-purchase-order-catalog-repository.js',
         'public/dispatch-scm.js', 'public/dispatch-scm.html']
IMAGE = 'mbbs-operator-app:scm-status-parity-20261001'
spec = importlib.util.spec_from_file_location('status_release_core', SERVER / 'tools/regular-stock-v2-deploy.py')
core = importlib.util.module_from_spec(spec)
spec.loader.exec_module(core)
core.RELEASE, core.CONTAINERS = RELEASE, {'app': APP}
docker, metadata, digest = core.docker, core.metadata, core.digest
HASH = """const fs=require('fs'),crypto=require('crypto'),out={};function walk(dir){for(const entry of fs.readdirSync(dir,{withFileTypes:true})){const p=dir+'/'+entry.name;if(entry.isDirectory())walk(p);else if(entry.isFile())out[p]=crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex')}}for(const dir of ['src','public','migrations'])walk(dir);console.log(JSON.stringify(out));"""


def state():
    return json.loads((RELEASE / 'manifest.json').read_text())


def save(name, value):
    (RELEASE / name).write_text(json.dumps(value, indent=2) + '\n')


def current(data):
    assert metadata(APP) == data['services']['app']['before'], 'Live app changed; rebase the scoped repair'
    assert {name: metadata(name) for name in data['untouched']} == data['untouched'], 'A dependency changed'
    assert {name: digest((SERVER / name).read_bytes()) for name in FILES} == data['sourceHashes']
    assert core.files_at(RELEASE / 'candidate') == data['sourceTree']


def prepare():
    os.umask(0o077)
    data = state()
    tests = (OUT / 'final-regressions.log').read_text()
    assert re.search(r'^# tests 98$', tests, re.M) and re.search(r'^# fail 0$', tests, re.M)
    checks = json.loads((OUT / 'static-checks.log').read_text())
    browser = json.loads((OUT / 'browser-checks.log').read_text())
    assert checks['syntax'] and checks['newLintFindings'] == checks['secretFindings'] == 0
    assert browser['browser'] and browser['statusCases'] == 6 and not browser['errors']
    old_tree, new_tree = core.files_at(RELEASE / 'before'), core.files_at(RELEASE / 'candidate')
    changed = sorted(name for name in new_tree if old_tree.get(name) != new_tree[name])
    assert changed == sorted(FILES)
    data['sourceHashes'] = {name: new_tree[name] for name in FILES}
    data['sourceTree'] = new_tree
    assert checks['sourceHashes'] == data['sourceHashes']
    data['services']['app']['image'] = IMAGE
    current(data)
    patch = ''
    stage = RELEASE / 'stage'
    for name in FILES:
        target = stage / 'overlay' / name
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(RELEASE / 'candidate' / name, target)
        patch += ''.join(difflib.unified_diff((RELEASE / 'before' / name).read_text().splitlines(True),
            (RELEASE / 'candidate' / name).read_text().splitlines(True), fromfile='a/' + name, tofile='b/' + name))
    (RELEASE / 'changes.patch').write_text(patch)
    parent = data['services']['app']['before']
    assert docker('image', 'inspect', '--format', '{{.Id}}', parent['image']).decode().strip() == parent['imageId']
    (stage / 'Dockerfile').write_text('FROM ' + parent['image'] + '\nCOPY --chown=node:node overlay/ /app/\n')
    with (RELEASE / 'build.log').open('wb') as log:
        subprocess.run(['sudo', '-n', 'docker', 'build', '--network', 'none', '--pull=false', '-t', IMAGE, str(stage)],
                       stdout=log, stderr=subprocess.STDOUT, check=True)
    data['services']['app']['candidateImageId'] = docker('image', 'inspect', '--format', '{{.Id}}', IMAGE).decode().strip()
    assert json.loads(docker('run', '--rm', '--network', 'none', '--entrypoint', 'node', IMAGE, '-e', HASH)) == new_tree
    docker('run', '--rm', '--network', 'none', '-e', 'MBBS_ENV_FILE=/nonexistent',
           '-e', 'NETSUITE_DIRECT_ACCESS_ENABLED=false', '-e', 'NETSUITE_MIRROR_ROLE=disabled',
           '--entrypoint', 'node', IMAGE, '--input-type=module', '-e', "await import('./src/server.js');process.exit(0)")
    for name, image in [('release', IMAGE), ('rollback', parent['imageId'])]:
        (RELEASE / ('compose.' + name + '.yml')).write_text('services:\n  app:\n    image: ' + image + '\n')
    core.config_check(data)
    current(data)
    save('manifest.json', data)
    print(json.dumps({'prepared': True, 'files': FILES, 'imageId': data['services']['app']['candidateImageId']}), flush=True)


def candidate_read(label, script, batched=False):
    data = state()
    current(data)
    runtime = json.loads(docker('inspect', APP))[0]
    env = dict(value.split('=', 1) for value in runtime['Config']['Env'])
    env.update({'NETSUITE_DIRECT_ACCESS_ENABLED': 'false', 'NETSUITE_MIRROR_ROLE': 'disabled',
                'MBBS_ENV_FILE': '/nonexistent', 'SCM_STATUS_BATCHED': '1' if batched else '0'})
    assert all('\n' not in value for value in env.values())
    network = next(iter(runtime['NetworkSettings']['Networks']))
    with tempfile.TemporaryDirectory(prefix='scm-status-private-') as folder:
        path = Path(folder) / 'runtime.env'
        path.write_text(''.join(key + '=' + value + '\n' for key, value in env.items()))
        path.chmod(0o600)
        args = ['sudo', '-n', 'docker', 'run', '--rm', '-i', '--read-only', '--network', network,
                '--volumes-from', APP + ':ro', '--env-file', str(path), '-w', '/app/tools',
                '--entrypoint', 'node', IMAGE, '--input-type=module']
        with (OUT / (label + '.json')).open('wb') as output:
            subprocess.run(args, input=(SERVER / script).read_bytes(), stdout=output, check=True, timeout=300)
    result = json.loads((OUT / (label + '.json')).read_text())
    if batched:
        assert not result['mismatches'] and not result['missingQueuedHold']
        assert result['queuedHoldFailures'] == result['excludedQueuedHoldFailures'] == 0
        print(json.dumps({key: result[key] for key in ['scanned', 'compared', 'queuedHoldChecked',
              'queuedHoldSources', 'queuedHoldSplits', 'queuedHoldFailures', 'excludedQueuedHoldFailures']}), flush=True)
    else:
        print(json.dumps({'ref': result['ref'], 'schedule': result['schedule'], 'catalog': result['catalog'], 'details': result['details']}), flush=True)
    current(data)


def verify():
    data = state()
    core.core.ready(data['services']['app']['candidateImageId'])
    actual = metadata(APP)
    assert actual['configuration'] == data['services']['app']['before']['configuration']
    assert {name: metadata(name) for name in data['untouched']} == data['untouched']
    assert json.loads(docker('exec', APP, 'node', '-e', HASH)) == data['sourceTree']
    probe = """import assert from 'node:assert/strict';import {createHash} from 'node:crypto';
const hashes=HASHES;for(const [file,expected] of Object.entries(hashes)){const r=await fetch('http://127.0.0.1:3000/'+file.replace('public/',''));assert.equal(r.status,200);assert.equal(createHash('sha256').update(Buffer.from(await r.arrayBuffer())).digest('hex'),expected)}console.log(JSON.stringify({assetsVerified:true}));""".replace('HASHES', json.dumps({name: data['sourceHashes'][name] for name in FILES if name.startswith('public/')}))
    assert json.loads(docker('exec', '-i', APP, 'node', '--input-type=module', input=probe.encode()))['assetsVerified']
    result = {'deployed': True, 'at': datetime.datetime.now(datetime.timezone.utc).isoformat(),
              'imageId': actual['imageId'], 'files': FILES, 'testsPassed': 98, 'browserStatusCases': 6,
              'configurationPreserved': True, 'dependenciesUnchanged': True, 'schemaChanged': False}
    save('result.json', result)
    print(json.dumps(result), flush=True)


def apply():
    data = state()
    current(data)
    audit = json.loads((OUT / 'candidate-population.json').read_text())
    assert not audit['mismatches'] and not audit['missingQueuedHold']
    assert audit['queuedHoldFailures'] == audit['excludedQueuedHoldFailures'] == 0
    core.config_check(data)
    active = core.database("SELECT count(*) FROM operator_netsuite_posting_commands WHERE status IN ('posting','finalizing')")
    assert active == '0', 'Wait for the operator posting operation to finish'
    command = ['up', '-d', '--no-build', '--no-deps', '--pull', 'never', 'app']
    try:
        with (RELEASE / 'publish.log').open('wb') as log:
            subprocess.run(core.compose(data) + command, cwd=SERVER.parent,
                           stdout=log, stderr=subprocess.STDOUT, check=True, timeout=60)
        verify()
    except Exception:
        with (RELEASE / 'rollback.log').open('wb') as log:
            subprocess.run(core.compose(data, 'compose.rollback.yml') + command, cwd=SERVER.parent,
                           stdout=log, stderr=subprocess.STDOUT, check=True, timeout=60)
        core.core.ready(data['services']['app']['before']['imageId'])
        save('rollback-result.json', {'restoredParent': True, 'schemaChanged': False})
        raise


if __name__ == '__main__':
    os.umask(0o077)
    mode = sys.argv[1]
    if mode == 'candidate-audit':
        candidate_read('candidate-population', 'tools/scm-status-parity-audit.mjs', True)
    elif mode == 'candidate-sn':
        candidate_read('candidate-sn1401822', 'tools/scm-sn1401822-read.mjs')
    else:
        {'prepare': prepare, 'apply': apply, 'verify': verify}[mode]()
