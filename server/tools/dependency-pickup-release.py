"""Deploy the verified dependency pickup repair over the exact tested live image."""
import datetime
import difflib
import importlib.util
import json
import os
from pathlib import Path
import signal
import subprocess
import sys

sys.dont_write_bytecode = True
SERVER = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('dependency_release', SERVER / 'tools/dispatch-source-save-release.py')
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)
release.RELEASE = SERVER / 'deployments/dependency-pickup-20261030'
release.FILES = ['src/scm-dependency-plan-reconciler.js', 'src/dispatch-pickup-visits.js', 'src/scm-dependency-command-service.js']
release.IMAGE = 'mbbs-operator-app:dependency-pickup-20261030'
release.ROLLBACK = 'mbbs-operator-app:rollback-dependency-pickup-20261030'


def smoke():
    assert os.environ.get('MBBS_TEST_ARTIFACT_DIR'), 'Disposable retention runner required'
    name = 'mbbs-dependency-pickup-image-' + str(os.getpid())
    code = """
import assert from 'node:assert/strict';
import {reconcileDependencyManagedPickups} from './src/scm-dependency-plan-reconciler.js';
import {validateDispatchPickupVisits} from './src/dispatch-pickup-visits.js';
const plan={orders:[{id:'GROUP',type:'SO',sourceYard:'3445',pickupLocations:['3445']}],
trucks:[{loads:[{id:'load',pickupVisitSchemaVersion:1,stops:[
{id:'base',type:'pick',location:'3445',orderId:'GROUP',orderRefs:['GROUP']},
{id:'obsolete',type:'pick',location:'2967',orderId:'GROUP',orderRefs:['GROUP']},
{id:'drop',type:'drop',orderId:'GROUP'}]}]}]};
const result=reconcileDependencyManagedPickups({plan,affectedTargetRefs:['GROUP'],reconcileExplicitPickupAllocations:true});
assert.deepEqual(result.trucks[0].loads[0].stops.map(s=>s.id),['base','drop']);
assert.deepEqual(validateDispatchPickupVisits(result),[]);
console.log('Built image dependency pickup check passed.');
"""
    try:
        output = release.docker('run', '--rm', '--name', name, '--init', '--network=none',
            '--cgroup-parent=mbbs-tests.slice', '--memory=512m', '--memory-swap=512m',
            '--cpus=0.5', '--pids-limit=64', '--read-only', '--tmpfs', '/tmp:rw,size=64m',
            '--label', 'com.mbbs.lifecycle=disposable-test', '-e', 'NODE_ENV=test',
            '-e', 'MBBS_ENV_FILE=.env.does-not-exist', '--entrypoint', 'node',
            release.IMAGE, '--input-type=module', '-e', code)
        print(output.decode().strip(), flush=True)
    finally:
        subprocess.run(['sudo', '-n', 'docker', 'rm', '-f', name], capture_output=True)
        for command in [('ps',), ('ps', '-a')]:
            print(release.docker(*command, '--format', '{{.Names}} {{.Status}}').decode(), end='')
        assert not release.docker('ps', '-aq', '--filter', 'name=^/' + name + '$').strip()


def prepare():
    if not os.environ.get('MBBS_TEST_ARTIFACT_DIR'):
        os.execv(sys.executable, [sys.executable, str(SERVER.parent / 'docker/retention/retention.py'),
            'run', '--', sys.executable, __file__, 'prepare'])
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(143))
    os.umask(0o077)
    proof = json.loads((SERVER / 'test/dependency-pickup-reconciliation-evidence.json').read_text())
    assert proof['passed'] and proof['focused']['status'] == 0
    assert proof['suite']['failures'] == proof['baseline']['failures']
    assert all(row['killed'] for row in proof['mutations']) and len(proof['mutations']) == 7
    release.RELEASE.mkdir(parents=True, exist_ok=True)
    stage = release.RELEASE / 'candidate'
    stage.mkdir(exist_ok=True)
    info = {'app': release.core.metadata(release.APP),
            'dependencies': [release.core.metadata(name) for name in release.DEPENDENCIES], 'files': proof['files']}
    assert info['app']['imageId'] == proof['baseImage'], 'Live image changed; rerun validation'
    patch = ''
    for file in release.FILES:
        assert release.digest(SERVER / file) == proof['files'][file], 'Source changed after tests: ' + file
        before = release.RELEASE / 'live-before' / file
        before.parent.mkdir(parents=True, exist_ok=True)
        before.write_bytes(release.docker('exec', release.APP, 'cat', '/app/' + file))
        assert release.digest(before) == proof['baselineFiles'][file], 'Live source changed: ' + file
        target = stage / file
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes((SERVER / file).read_bytes())
        patch += ''.join(difflib.unified_diff(before.read_text().splitlines(True), target.read_text().splitlines(True), fromfile='a/' + file, tofile='b/' + file))
    (release.RELEASE / 'release.patch').write_text(patch)
    release.current(info)
    release.docker('tag', info['app']['imageId'], release.ROLLBACK)
    (stage / 'Dockerfile').write_text('FROM ' + release.ROLLBACK + '\n' + ''.join(
        'COPY --chown=node:node ' + file + ' /app/' + file + '\n' for file in release.FILES))
    with (release.RELEASE / 'build.log').open('wb') as output:
        subprocess.run(['sudo', '-n', 'docker', 'build', '--network=none', '--pull=false', '-t', release.IMAGE, str(stage)],
            stdout=output, stderr=subprocess.STDOUT, check=True)
    info['imageId'] = release.docker('image', 'inspect', '--format', '{{.Id}}', release.IMAGE).decode().strip()
    for name, image in [('compose.release.yml', release.IMAGE), ('compose.rollback.yml', release.ROLLBACK)]:
        (release.RELEASE / name).write_text('services:\n  app:\n    image: ' + image + '\n')
    release.save('manifest.json', info)
    smoke()
    release.save('verified.json', proof)
    release.current(info)
    print(json.dumps({'prepared': True, 'imageId': info['imageId'], 'files': release.FILES}), flush=True)


def verify():
    info = release.state()
    release.core.ready(info['imageId'])
    assert release.core.metadata(release.APP)['configuration'] == info['app']['configuration'], 'App configuration changed'
    assert [release.core.metadata(name) for name in release.DEPENDENCIES] == info['dependencies'], 'Dependency changed'
    rows = release.docker('exec', release.APP, 'sha256sum', *['/app/' + name for name in release.FILES]).decode().splitlines()
    assert {row.split()[1].removeprefix('/app/'): row.split()[0] for row in rows} == info['files']
    result = {'deployed': True, 'at': datetime.datetime.now(datetime.timezone.utc).isoformat(),
              'imageId': info['imageId'], 'configurationPreserved': True, 'dependenciesUnchanged': True,
              'health': 200, 'sourceHashesVerified': True, 'directDatabaseEdits': False}
    release.save('deployment-result.json', result)
    print(json.dumps(result), flush=True)


release.verify = verify
if __name__ == '__main__':
    {'prepare': prepare, 'apply': release.apply, 'verify': verify}[sys.argv[1]]()
