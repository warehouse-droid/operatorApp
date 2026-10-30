"""Scoped Backorder review update with exact-image validation and app-only rollback."""
import atexit
import importlib.util
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tarfile
import urllib.request

SERVER = Path(__file__).resolve().parents[1]
ROOT = SERVER.parent
spec = importlib.util.spec_from_file_location('backorder_review_release', SERVER / 'tools/scm-po-to-handoff-release.py')
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)
core = release.core
RELEASE = SERVER / 'deployments/backorder-review-flow-20261022'
release.RELEASE = core.RELEASE = RELEASE
release.IMAGE = 'mbbs-operator-app:backorder-review-flow-20261022'
release.ROLLBACK = release.IMAGE + '-rollback'
release.FILES = json.loads((RELEASE / 'manifest.json').read_text())['files']
release.CHECK = 'mbbs-backorder-review-image-check'


def checked():
    data = core.state()
    assert release.source_hashes() == data['sourceHashes']
    assert all(core.sha((RELEASE / 'candidate' / n).read_bytes()) == h for n, h in data['sourceHashes'].items())
    return data


def prepare():
    data = core.state()
    assert core.metadata(core.APP) == data['app']
    for name in data['files']:
        target = RELEASE / 'candidate' / name
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(SERVER / name, target)
    data['sourceHashes'] = release.source_hashes()
    data['candidateTree'] = {**data['beforeTree'], **data['sourceHashes']}
    assert all(data['beforeHashes'][name] != value for name, value in data['sourceHashes'].items())
    core.save('manifest.json', data)
    release.current(data)
    print(json.dumps({'prepared': True, 'files': data['files']}))


def validate_image():
    data = checked()
    assert os.environ.get('MBBS_TEST_ARTIFACT_DIR'), 'Use the repository retention runner'
    artifact = Path(os.environ['MBBS_TEST_ARTIFACT_DIR'])
    artifact.chmod(0o777)

    def cleanup():
        subprocess.run(['docker', 'rm', '-fv', release.CHECK], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    atexit.register(cleanup)
    try:
        actual = json.loads(core.bounded(data['candidateImageId'], release.CHECK, 'node', '-e', core.HASH_SCRIPT))
        assert actual == data['candidateTree']
        runtime = artifact / 'runtime'
        runtime.mkdir(mode=0o755)
        archive = core.bounded(data['candidateImageId'], release.CHECK, 'tar', '-cf', '-', '-C', '/app',
            'src', 'public', 'migrations', 'package.json', 'package-lock.json')
        with tarfile.open(fileobj=io.BytesIO(archive)) as stream:
            stream.extractall(runtime, filter='data')
        assert core.files_at(runtime) == data['candidateTree']
        env = dict(os.environ, BACKORDER_REVIEW_RUNTIME=str(runtime), BACKORDER_REVIEW_REPORT='evidence')
        subprocess.run(['bash', str(SERVER / 'tools/backorder-review-flow-test.sh'),
            'node', 'tools/backorder-review-flow-checks.mjs', 'final'], cwd=ROOT, env=env, check=True)
        evidence = json.loads((SERVER / 'test/backorder-review-flow-evidence.json').read_text())
        assert evidence['passed'] and evidence['newFailures'] == 0
        assert evidence['sourceHashes'] == data['sourceHashes']
        core.save('validation.json', {**evidence, 'imageId': data['candidateImageId'], 'runtimeFilesVerified': len(actual)})
        core.save('image-check.json', {'passed': True, 'imageId': data['candidateImageId'], 'filesVerified': len(actual)})
    finally:
        cleanup()


def live_requests():
    script = """import {query,pool,withTransaction} from './src/db.js';
import {getBackorderRequest} from './src/backorder-request-service.js';
import {canAttachBackorderSalesOrder} from './public/backorder-review-policy.js';
try {await withTransaction(async()=>{await query('SET TRANSACTION READ ONLY');
 await query(\"SET LOCAL statement_timeout='15s'\");
 const ids=(await query(\"SELECT id FROM sales_stock_requests WHERE request_ref IN ('STREQ-000165','STREQ-000186') ORDER BY request_ref\")).rows;
 const result=[];for(const {id} of ids){const d=await getBackorderRequest(id,{audience:'scm'});
 result.push({request:d.requestRef,stage:d.stage,canAttachOptionalSO:canAttachBackorderSalesOrder(d),
  materials:d.lines.map(l=>({id:l.id,supplyStatus:l.supplyStatus,salesDecision:l.salesDecision}))});}
 console.log(JSON.stringify(result));});}finally{await pool.end();}"""
    return json.loads(core.docker('exec', '-i', core.APP, 'node', '--input-type=module', input=script.encode()))


def container_audit():
    containers = {key: core.docker(*args, '--format', '{{.Names}} {{.Status}}').decode().splitlines()
        for key, args in [('running', ['ps']), ('all', ['ps', '-a'])]}
    production = {core.APP, *core.DEPENDENCIES}
    others = set()
    for rows in containers.values():
        names = {row.split()[0] for row in rows}
        assert production <= names
        assert not any(name.startswith('mbbs-backorder-review-') for name in names)
        others.update(names - production)
    for name in others:
        label = core.docker('inspect', '--format', '{{ index .Config.Labels "com.mbbs.lifecycle" }}', name).decode().strip()
        assert label == 'disposable-test', 'Unexpected non-production container: ' + name
    core.save('containers.json', {**containers, 'otherActiveTests': sorted(others), 'taskTestsRemoved': True})
    return sorted(others)


def verify():
    data = checked()
    core.ready(data['candidateImageId'])
    live = core.metadata(core.APP)
    assert live['configuration'] == data['app']['configuration']
    assert [core.metadata(name) for name in core.DEPENDENCIES] == data['dependencies']
    assert json.loads(core.docker('exec', core.APP, 'node', '-e', core.HASH_SCRIPT)) == data['candidateTree']
    for name in data['files']:
        if not name.startswith('public/'):
            continue
        path = {'public/sales-stock-requests.html': '/sales/stock-requests',
            'public/scm-stock-requests.html': '/scm/stock-requests'}.get(name, '/' + name.removeprefix('public/'))
        with urllib.request.urlopen('http://127.0.0.1:3000' + path, timeout=10) as response:
            assert response.status == 200 and core.sha(response.read()) == data['sourceHashes'][name]
    requests = live_requests()
    other_tests = container_audit()
    result = {'deployed': True, 'at': core.now(), 'image': release.IMAGE, 'imageId': live['imageId'],
        'healthy': True, 'configurationPreserved': True, 'dependenciesUnchanged': True,
        'runtimeFilesVerified': len(data['candidateTree']), 'requests': requests, 'rollbackImage': release.ROLLBACK,
        'otherActiveTests': other_tests, 'taskTestsRemoved': True}
    core.save('deployed.json', result)
    print(json.dumps(result))


def deploy():
    data = checked()
    validation = json.loads((RELEASE / 'validation.json').read_text())
    assert validation['passed'] and validation['newFailures'] == 0
    assert validation['sourceHashes'] == data['sourceHashes']
    assert validation['imageId'] == data['candidateImageId']
    release.deploy()


release.checked = checked
release.verify = verify

if __name__ == '__main__':
    os.umask(0o077)
    {'prepare': prepare, 'build': release.build, 'validate-image': validate_image,
        'deploy': deploy, 'verify': verify, 'containers': container_audit}[sys.argv[1]]()
