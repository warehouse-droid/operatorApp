"""Release the bounded NetSuite damage description fix over the current image."""
import datetime
import importlib.util
import json
import io
import os
from pathlib import Path
import shutil
import sys
import tarfile

SERVER = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('damage_receipt_release', SERVER / 'tools/receiving-posting-status-deploy.py')
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)
core = release.core
core.RELEASE = Path('/home/ubuntu/operatorapp-deploy-backups/damage-description-fix-20260923-v1')
core.BEFORE = Path('/home/ubuntu/operatorapp-deploy-backups/operator-inventory-20260923-v1/candidate')
core.FILES = core.EXISTING = ['src/inventory-damage-service.js']
core.ADDED = []
core.IMAGE = 'mbbs-operator-app:damage-description-fix-20260923-v1'
core.ROLLBACK = 'mbbs-operator-app:rollback-damage-description-fix-20260923-v1'
CHECKS = SERVER / 'test-artifacts/damage-description-fix'
original_docker = core.docker


def docker(*args, **kwargs):
    if args[0] != 'cp':
        return original_docker(*args, **kwargs)
    source, destination = args[1:]
    assert source.startswith(core.APP + ':/app/')
    destination = Path(destination)
    assert destination.is_relative_to(core.RELEASE / 'baseline')
    relative = source.split(':/app/', 1)[1]
    archive = original_docker('exec', core.APP, 'tar', '-C', '/app', '-cf', '-', relative)
    with tarfile.open(fileobj=io.BytesIO(archive)) as captured:
        captured.extractall(destination.parent, filter='data')
    return b''


core.docker = docker


def prepare():
    core.prepare()
    state = core.manifest()
    state['unchangedSources'] = {name: value for name, value in core.files_at(core.RELEASE / 'baseline').items() if name not in core.FILES}
    core.save('manifest.json', state)
    candidate = core.RELEASE / 'candidate'
    for name in ['test', 'tools', 'contracts']:
        (candidate / name).symlink_to(SERVER / name, target_is_directory=True)
    for pattern in ['*.js', '*.json', 'Dockerfile*']:
        for path in SERVER.glob(pattern):
            if not (candidate / path.name).exists():
                shutil.copy2(path, candidate / path.name)


def validate():
    state = core.manifest()
    core.current(state)
    sources = json.loads((CHECKS / 'damage-description-fix/sources.json').read_text())['sources']
    for name, value in sources.items():
        assert core.digest((SERVER / name).read_bytes()) == value, 'Verified source changed: ' + name
    assert sources[core.FILES[0]] == state['after'][core.FILES[0]]
    assert json.loads((CHECKS / 'operator-inventory/comparison.json').read_text())['unexpected'] == []
    assert json.loads((CHECKS / 'damage-description-fix/changed-coverage.json').read_text())['missed'] == []
    assert all(row['killed'] for row in json.loads((CHECKS / 'damage-description-fix/mutations.json').read_text()))
    for path in [CHECKS / 'focused.log', core.RELEASE / 'candidate-tests.log']:
        log = path.read_text()
        assert '# fail 0' in log and '# pass 47' in log, 'Candidate feature verification required'
    core.save('verified.json', {'passed': True, 'imageId': state['candidateImageId'], 'sources': state['after']})
    print(json.dumps({'verified': True, 'imageId': state['candidateImageId']}))


def verify():
    state = core.manifest()
    core.ready(state['candidateImageId'])
    actual = core.metadata(core.APP)
    assert actual['configuration'] == state['app']['configuration'], 'Runtime settings changed'
    assert [core.metadata(name) for name in core.DEPENDENCIES] == state['dependencies'], 'Other services changed'
    expected = {**state['unchangedSources'], **state['after']}
    hashes = core.docker('exec', core.APP, 'sha256sum', *['/app/' + name for name in expected]).decode().splitlines()
    assert {line.split()[1].removeprefix('/app/'): line.split()[0] for line in hashes} == expected
    script = """import assert from 'node:assert/strict';
for(const base of ['http://127.0.0.1:3000','https://test.mbbsoperation.com']) {
 const health=await fetch(base+'/health');assert.equal(health.status,200);assert.equal((await health.json()).ok,true);
 assert.equal((await fetch(base+'/operator')).status,200);
 assert.equal((await fetch(base+'/api/inventory/damage/config')).status,401);
}console.log(JSON.stringify({localHealth:200,publicHealth:200,operatorPage:200,anonymousDamageApi:401}));"""
    probes = json.loads(core.docker('exec', '-i', core.APP, 'node', '--input-type=module', input=script.encode()))
    result = {'deployed': True, 'at': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'imageId': actual['imageId'],
              'changedFiles': core.FILES, 'verifiedFiles': len(expected), 'configurationPreserved': True, 'otherServicesUnchanged': True, **probes}
    core.save('deployment-result.json', result)
    print(json.dumps(result))


def apply():
    assert core.database("SELECT count(*) FROM inventory_damage_reports WHERE status='posting';").strip() == '0', 'Damage posting active; wait for an idle cutover'
    release.verify = verify
    release.apply()


if __name__ == '__main__':
    os.umask(0o077)
    {'prepare': prepare, 'build': core.build, 'validate': validate, 'apply': apply, 'verify': verify}[sys.argv[1]]()
