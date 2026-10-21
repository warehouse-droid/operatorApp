"""Three-file release over the running image; no migrations or unrelated files."""
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys

SERVER = Path(__file__).resolve().parents[1]
ROOT = SERVER.parent
PREVIOUS = SERVER / 'test-artifacts/special-stock-units-release-20260926'
RELEASE = SERVER / 'test-artifacts/special-stock-units-release-20260926-v2'
EVIDENCE = SERVER / 'test-artifacts/special-workflow-review/rest-units'
FILES = ['src/special-stock-request-netsuite.js', 'src/special-stock-netsuite-adapter.js', 'src/special-stock-quantity-adapter.js']
SERVICES = {'app': 'mbbs-operator-app-app-1', 'webhook-worker': 'mbbs-operator-app-webhook-worker-1'}
DEPENDENCIES = ['mbbs-operator-app-db-1', 'mbbs-operator-app-ollama-1']
IMAGE = 'mbbs-operator-app:special-stock-rest-units-20260926-v2'
ROLLBACK = 'mbbs-operator-app:rollback-special-stock-rest-units-20260926-v2'
spec = importlib.util.spec_from_file_location('core', SERVER / 'tools/operator-display-settings-deploy.py')
core = importlib.util.module_from_spec(spec)
spec.loader.exec_module(core)
docker = core.docker


def save(name, value):
    path = RELEASE / name
    path.write_text(json.dumps(value, indent=2) + '\n')
    path.chmod(0o600)


def load():
    return json.loads((RELEASE / 'manifest.json').read_text())


def evidence():
    assert json.loads((EVIDENCE / 'summary.json').read_text())['completed']
    hashes = json.loads((EVIDENCE / 'source-manifest.json').read_text())
    for file, sha in hashes.items():
        assert core.digest((SERVER / file).read_bytes()) == sha, 'Verified source changed: ' + file
    return {file: hashes[file] for file in FILES}


def current(info):
    assert evidence() == info['files']
    assert {s: core.metadata(c) for s, c in SERVICES.items()} == info['services'], 'Live services changed'
    assert [core.metadata(c) for c in DEPENDENCIES] == info['dependencies'], 'Dependency changed'


def compose(info, filename):
    args = ['sudo', '-n', 'docker', 'compose', '-p', 'mbbs-operator-app']
    for file in info['services']['app']['configFiles'].split(','):
        args += ['-f', file]
    return args + ['-f', str(RELEASE / filename), '--env-file', str(ROOT / 'docker/env/.env')]


def config_gate(info):
    resolved = json.loads(subprocess.check_output(compose(info, 'compose.release.yml') + ['config', '--format', 'json'], cwd=ROOT))
    image = json.loads(docker('image', 'inspect', IMAGE))[0]['Config']
    for service, container in SERVICES.items():
        live = json.loads(docker('inspect', container))[0]['Config']
        config = resolved['services'][service]
        env = dict(entry.split('=', 1) for entry in image['Env'])
        env.update({k: str(v) for k, v in config.get('environment', {}).items()})
        assert env == dict(entry.split('=', 1) for entry in live['Env']), 'Environment drift'
        for field, key in [('Cmd', 'command'), ('Entrypoint', 'entrypoint'), ('User', 'user'), ('WorkingDir', 'working_dir')]:
            assert (image.get(field) if config.get(key) is None else config[key]) == live.get(field), 'Command drift'
    save('compose.private.json', resolved)


def prepare():
    os.umask(0o077)
    hashes = evidence()
    RELEASE.mkdir(mode=0o700)
    info = {'files': hashes, 'services': {s: core.metadata(c) for s, c in SERVICES.items()},
            'dependencies': [core.metadata(c) for c in DEPENDENCIES]}
    assert len({v['imageId'] for v in info['services'].values()}) == 1, 'Base images differ'
    previous = json.loads((PREVIOUS / 'manifest.json').read_text())
    for service, container in SERVICES.items():
        assert info['services'][service]['imageId'] == previous['imageId'], 'Unexpected production release'
        for file in FILES:
            assert core.digest(docker('exec', container, 'cat', '/app/' + file)) == previous['files'][file], 'Live baseline differs: ' + file
    stage = RELEASE / 'stage'
    (stage / 'src').mkdir(parents=True)
    for file in FILES:
        shutil.copy2(SERVER / file, stage / file)
    base = info['services']['app']['imageId']
    docker('tag', base, ROLLBACK)
    (stage / 'Dockerfile').write_text('FROM ' + ROLLBACK + '\n' + ''.join('COPY --chown=node:node ' + f + ' /app/' + f + '\n' for f in FILES))
    with (RELEASE / 'build.log').open('wb') as log:
        subprocess.run(['sudo', '-n', 'docker', 'build', '--network', 'none', '--pull=false', '-t', IMAGE, str(stage)], stdout=log, stderr=subprocess.STDOUT, check=True)
    info['imageId'] = docker('image', 'inspect', '--format', '{{.Id}}', IMAGE).decode().strip()
    for filename, image in [('compose.release.yml', IMAGE), ('compose.rollback.yml', base)]:
        (RELEASE / filename).write_text('services:\n' + ''.join('  ' + s + ':\n    image: ' + image + '\n' for s in SERVICES))
    actual = docker('run', '--rm', '--network', 'none', '--entrypoint', 'sha256sum', IMAGE, *['/app/' + f for f in FILES]).decode().splitlines()
    assert {line.split()[1].removeprefix('/app/'): line.split()[0] for line in actual} == hashes
    smoke = """import assert from 'node:assert/strict';
import {buildSpecialSalesOrderPayload,buildSpecialPurchaseOrderPayload} from './src/special-stock-request-netsuite.js';
import {specialRestUnitId} from './src/special-stock-netsuite-adapter.js';
import {prepareSpecialQuantityPlan} from './src/special-stock-quantity-adapter.js';
const lines=[{itemId:2055,unitId:865,quantity:500,rate:17},{itemId:1784,unitId:246,quantity:11,rate:40}];
const so=buildSpecialSalesOrderPayload({caseId:62,netsuiteLocationId:1,pickupMethodId:1,draft:{customerId:8444,materialLines:lines}});
const po=buildSpecialPurchaseOrderPayload({caseId:62,netsuiteLocationId:1,vendorId:331,lines});
for(const p of [so,po])assert.deepEqual(p.item.items.map(l=>l.units),['865','246']);
for(const p of [so,po])assert.deepEqual(p.item.items.map(l=>l.location),[{id:'1'},{id:'1'}]);
assert.equal(specialRestUnitId('865'),'865');assert.equal(typeof prepareSpecialQuantityPlan,'function');
console.log(JSON.stringify({passed:true,units:['865','246'],network:'none'}));"""
    save('image-smoke.json', json.loads(docker('run', '--rm', '--network', 'none', '--entrypoint', 'node', IMAGE, '--input-type=module', '-e', smoke)))
    save('manifest.json', info)
    current(info)
    config_gate(info)
    print(json.dumps({'prepared': True, 'imageId': info['imageId'], 'files': FILES}), flush=True)


def verify():
    info = load()
    core.ready(info['imageId'])
    for service, container in SERVICES.items():
        actual = core.metadata(container)
        assert actual['imageId'] == info['imageId']
        assert actual['configuration'] == info['services'][service]['configuration']
        row = json.loads(docker('inspect', container))[0]
        assert row['State']['Running'] and row['RestartCount'] == 0
        hashes = docker('exec', container, 'sha256sum', *['/app/' + f for f in FILES]).decode().splitlines()
        assert {line.split()[1].removeprefix('/app/'): line.split()[0] for line in hashes} == info['files']
    assert [core.metadata(c) for c in DEPENDENCIES] == info['dependencies']
    result = {'deployed': True, 'imageId': info['imageId'], 'configurationPreserved': True, 'dependenciesUnchanged': True, 'files': FILES}
    save('deployment-result.json', result)
    print(json.dumps(result), flush=True)


def apply():
    info = load()
    current(info)
    config_gate(info)
    sql = """SELECT json_build_object(
      'operatorPosting',(SELECT count(*) FROM operator_netsuite_posting_commands WHERE status IN ('queued','posting','finalizing')),
      'webhooks',(SELECT count(*) FROM netsuite_order_webhook_inbox WHERE status IN ('running','processing')),
      'specialCreating',(SELECT count(*) FROM sales_special_stock_cases WHERE sales_order_operation_status='creating' OR purchase_order_operation_status='creating'),
      'quantityApplying',(SELECT count(*) FROM sales_special_stock_cases WHERE quantity_review->>'status'='applying'))"""
    counts = json.loads(docker('exec', DEPENDENCIES[0], 'psql', '-U', 'mbbs_app', '-d', 'mbbs_yard', '-XAt', '-v', 'ON_ERROR_STOP=1', '-c', sql))
    save('preflight.json', counts)
    assert not any(counts.values()), 'Wait for active order work before restarting'
    current(info)
    try:
        with (RELEASE / 'cutover.log').open('wb') as log:
            subprocess.run(compose(info, 'compose.release.yml') + ['up', '-d', '--no-build', '--no-deps', '--pull', 'never', *SERVICES], cwd=ROOT, stdout=log, stderr=subprocess.STDOUT, check=True, timeout=60)
        verify()
    except Exception:
        with (RELEASE / 'rollback.log').open('wb') as log:
            subprocess.run(compose(info, 'compose.rollback.yml') + ['up', '-d', '--no-build', '--no-deps', '--pull', 'never', *SERVICES], cwd=ROOT, stdout=log, stderr=subprocess.STDOUT, check=True, timeout=60)
        core.ready(info['services']['app']['imageId'])
        raise


if __name__ == '__main__':
    {'prepare': prepare, 'apply': apply, 'verify': verify}[sys.argv[1]]()
