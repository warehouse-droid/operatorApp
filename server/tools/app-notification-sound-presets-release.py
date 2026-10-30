#!/usr/bin/env python3
"""Release only the tested built-in notification sounds over the live image."""
import atexit
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys

SERVER = Path(__file__).resolve().parents[1]
TASK = SERVER / 'test-artifacts/app-notification-sound-presets-20261021'
RELEASE = SERVER / 'deployments/app-notification-sound-presets-20261021'
OUT = TASK / 'release-final'
IMAGE = 'mbbs-operator-app:notification-sound-presets-20261021'
spec = importlib.util.spec_from_file_location('notification_release', SERVER / 'tools/delivery-timeslot-notifications-release.py')
base = importlib.util.module_from_spec(spec)
spec.loader.exec_module(base)
base.TASK, base.OUT, base.RELEASE, base.IMAGE = TASK, OUT, RELEASE, IMAGE
core = base.core
core.RELEASE, core.IMAGE, core.ROLLBACK = RELEASE, IMAGE, IMAGE + '-rollback'
core.READ_NAME = 'mbbs-notification-sound-presets-reader'
core.CHECK_NAME = 'mbbs-notification-sound-presets-import'


def inputs():
    report = json.loads((TASK / 'focused/test-results.json').read_text())
    assert report['tests'] >= 38 and report['passed'] == report['tests']
    assert report['failed'] == report['skipped'] == report['testExit'] == report['lintExit'] == 0
    assert (TASK / 'focused/teardown.log').read_text().endswith('teardown_exit=0\n')
    names = json.loads((TASK / 'before-hashes.json').read_text())
    hashes = {name: report['runtimeHashes'][name] for name in names}
    for name, sha in hashes.items():
        assert core.sha((SERVER / name).read_bytes()) == sha, 'Tested input changed: ' + name
    return hashes


base.tested_inputs = inputs


def validate():
    data = core.state()
    core.current(data)
    environment = {**os.environ, 'NOTIFICATION_SOURCE': str(RELEASE / 'candidate'),
                   'NOTIFICATION_EVIDENCE_DIR': str(OUT)}
    with (RELEASE / 'validation.log').open('wb') as log:
        result = subprocess.run(['bash', str(SERVER / 'tools/app-notification-roles-sounds-test.sh'), 'focused'],
                                cwd=SERVER.parent, env=environment, stdout=log, stderr=subprocess.STDOUT)
    assert result.returncode == 0, 'Exact candidate verification failed; see validation.log'
    assert (OUT / 'teardown.log').read_text().endswith('teardown_exit=0\n')
    tests = json.loads((OUT / 'test-results.json').read_text())
    assert tests['tests'] >= 38 and tests['passed'] == tests['tests']
    assert tests['failed'] == tests['skipped'] == tests['lintExit'] == tests['testExit'] == 0
    assert all(data['candidateTree'][name] == sha for name, sha in tests['runtimeHashes'].items())
    core.current(data)
    core.save('validation-passed.json', {'passed': True, 'at': core.now(),
              'candidateTreeHash': data['candidateTreeHash'], 'testResults': tests})
    print(json.dumps({'validated': True, 'testResults': tests}), flush=True)


def verify():
    data = core.state()
    core.ready(data['candidateImageId'])
    live = core.metadata(core.APP)
    assert live['imageId'] == data['candidateImageId']
    assert live['configuration'] == data['app']['configuration']
    assert [core.metadata(name) for name in core.DEPENDENCIES] == data['dependencies']
    actual = json.loads(core.docker('exec', core.APP, 'node', '-e', core.HASH_SCRIPT))
    assert actual == data['candidateTree'], 'Live runtime differs from the tested candidate'
    assets = {name: data['candidateTree'][name] for name in data['files']}
    http = core.http_check(assets, ['/api/sales/delivery-requests/meta', '/api/dispatch/delivery-requests/meta'])
    core.save('deployment-result.json', {'deployed': True, 'at': core.now(), 'image': IMAGE,
              'imageId': live['imageId'], 'candidateTreeHash': data['candidateTreeHash'],
              'changedFiles': data['files'], 'runtimeFilesVerified': len(actual),
              'configurationPreserved': True, 'workerAndDependenciesUnchanged': True,
              'schemaChanged': False, 'http': http})
    print(json.dumps({'deployed': True, 'image': IMAGE, 'http': http}), flush=True)


base.verify = verify

if __name__ == '__main__':
    atexit.register(core.cleanup_manual)
    {'capture': base.capture, 'rebase': base.rebase, 'validate': validate,
     'build': core.build, 'apply': base.apply, 'verify': verify}[sys.argv[1]]()
