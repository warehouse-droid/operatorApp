"""Release the Sales quote, charge edit and note corrections as a scoped overlay on the live app."""
import datetime
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys

SERVER = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('corrections_release_core', SERVER / 'tools/special-stock-updates-deploy.py')
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)
release.RELEASE = SERVER / 'deployments/special-sales-request-corrections-20261003'
release.EVIDENCE = SERVER / 'test-artifacts/special-workflow-review/sales-request-corrections-20261003'
release.FILES = json.loads((SERVER / 'tools/special-sales-request-corrections-files.json').read_text())
release.CONTAINERS = {'app': 'mbbs-operator-app-app-1'}
release.DEPENDENCIES.append('mbbs-operator-app-webhook-worker-1')
release.core.RELEASE, release.core.CONTAINERS = release.RELEASE, release.CONTAINERS
docker, database, save, state = release.docker, release.database, release.save, release.state


def capture():
    release.capture()
    data = state()
    data['services']['app']['image'] = 'mbbs-operator-app:special-sales-request-corrections-20261003'
    save('manifest.json', data)


def prepare():
    release.prepare()
    data = state()
    for kind in ['release', 'rollback']:
        image = data['services']['app']['image'] if kind == 'release' else data['services']['app']['before']['imageId']
        (release.RELEASE / ('compose.' + kind + '.yml')).write_text('services:\n  app:\n    image: ' + image + '\n')


def sync_checks():
    directory = release.RELEASE / 'checks-app'
    shutil.copytree(release.RELEASE / 'candidate-app', directory, dirs_exist_ok=True)
    for folder in ['test', 'tools']:
        shutil.copytree(SERVER / folder, directory / folder, dirs_exist_ok=True)
    runner, remote = 'mbbs-special-review-runner', '/tmp/special-sales-request-corrections-release-app'
    docker('exec', runner, 'node', '-e', "const f=require('fs');f.rmSync(process.argv[1],{recursive:true,force:true});f.mkdirSync(process.argv[1]);", remote)
    docker('cp', str(directory) + '/.', runner + ':' + remote)
    docker('exec', runner, 'node', '-e', "const f=require('fs');f.symlinkSync('/app/node_modules',process.argv[1]+'/node_modules','dir');f.symlinkSync('/app/test-artifacts',process.argv[1]+'/test-artifacts','dir');", remote)
    print(json.dumps({'candidateChecksSynced': True}), flush=True)


def verify():
    data = state()
    row = data['services']['app']
    release.core.core.ready(row['candidateImageId'])
    current = release.metadata(release.CONTAINERS['app'])
    assert current['imageId'] == row['candidateImageId']
    assert current['configuration'] == row['before']['configuration']
    assert json.loads(docker('exec', release.CONTAINERS['app'], 'node', '-e', release.TREE)) == json.loads((release.RELEASE / 'app-source-tree.json').read_text())
    assert {name: release.metadata(name) for name in release.DEPENDENCIES} == data['dependencies']
    runtime = json.loads(docker('inspect', release.CONTAINERS['app']))[0]
    assert runtime['State']['Running'] and runtime['RestartCount'] == 0
    probe = (SERVER / 'tools/special-sales-request-corrections-live.mjs').read_text().replace('RELEASE_HASHES', json.dumps(row['sourceHashes']))
    checks = json.loads(docker('exec', '-i', release.CONTAINERS['app'], 'node', '--input-type=module', input=probe.encode()))
    result = {'deployed': True, 'at': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'appImage': row['candidateImageId'],
              'configurationAndDependenciesPreserved': True, 'schemaChanged': False, **checks}
    save('result.json', result)
    print(json.dumps(result), flush=True)


def apply():
    os.umask(0o077)
    data = state()
    release.current(data)
    release.validate_checks(data)
    release.core.config_check(data)
    active = release.active_work()
    save('active-before-release.json', active)
    assert not any(active.values()), 'Wait for active operations: ' + json.dumps(active)
    try:
        with (release.RELEASE / 'publish.log').open('wb') as log:
            subprocess.run(release.core.compose(data) + ['up', '-d', '--no-build', '--no-deps', '--pull', 'never', 'app'], cwd=SERVER.parent,
                           stdout=log, stderr=subprocess.STDOUT, check=True, timeout=60)
        verify()
    except Exception:
        with (release.RELEASE / 'rollback.log').open('wb') as log:
            subprocess.run(release.core.compose(data, 'compose.rollback.yml') + ['up', '-d', '--no-build', '--no-deps', '--pull', 'never', 'app'],
                           cwd=SERVER.parent, stdout=log, stderr=subprocess.STDOUT, check=True, timeout=60)
        release.core.core.ready(data['services']['app']['before']['imageId'])
        save('rollback-result.json', {'restoredPreviousApp': True, 'schemaUnchanged': True})
        raise


if __name__ == '__main__':
    {'capture': capture, 'stage': release.stage, 'freeze': release.freeze, 'prepare': prepare, 'sync-checks': sync_checks, 'apply': apply, 'verify': verify}[sys.argv[1]]()
