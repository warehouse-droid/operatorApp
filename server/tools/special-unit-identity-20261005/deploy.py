"""Release only the tested UOM adapter, preserving configuration and the prior image."""
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import time

ROOT = Path(__file__).resolve().parents[2]
BACKUP = Path('/home/ubuntu/operatorapp-investigations/special-unit-identity-20261005')
OUT = ROOT / 'test-artifacts/special-unit-identity-20261005'
RELEASE = BACKUP / 'release'
APP = 'mbbs-operator-app-app-1'
SOURCE = 'src/special-stock-netsuite-adapter.js'
IMAGE = 'mbbs-operator-app:special-unit-identity-20261005'
BASE_IMAGE = 'mbbs-operator-app:special-unit-identity-base-20261005'
STATE = json.loads((BACKUP / 'runtime.json').read_text())


def docker(*args, **kwargs):
    return subprocess.check_output(['docker', *args], **kwargs)


def sha(value):
    return hashlib.sha256(value).hexdigest()


def metadata(name):
    info = json.loads(docker('inspect', name))[0]
    configuration = {'Config': {k: v for k, v in info['Config'].items() if k not in ['Image', 'Labels', 'Hostname']},
                     'HostConfig': info['HostConfig']}
    configuration['Config']['Env'] = sorted(configuration['Config']['Env'])
    return {'image': info['Image'], 'configurationHash': sha(json.dumps(configuration, sort_keys=True).encode())}


def live_hash():
    script = "console.log(require('crypto').createHash('sha256').update(require('fs').readFileSync(process.argv[1])).digest('hex'))"
    return docker('exec', APP, 'node', '-e', script, '/app/' + SOURCE).decode().strip()


def compose(override):
    labels = STATE['compose']
    args = ['sudo', '-n', 'docker', 'compose', '--project-name', labels['com.docker.compose.project'],
            '--project-directory', labels['com.docker.compose.project.working_dir'],
            '--env-file', labels['com.docker.compose.project.environment_file']]
    for file in labels['com.docker.compose.project.config_files'].split(','):
        args += ['-f', file]
    return args + ['-f', str(override)]


def verify():
    manifest = json.loads((RELEASE / 'manifest.json').read_text())
    assert metadata(APP)['image'] == manifest['candidateImageId']
    assert metadata(APP)['configurationHash'] == STATE['configurationHash'], 'Service configuration drift'
    assert live_hash() == manifest['adapterHash']
    script = (ROOT / 'tools/special-unit-identity-20261005/verify-live.mjs').read_bytes()
    result = json.loads(docker('exec', '-i', '-w', '/app', APP, 'node', '--input-type=module', input=script))
    result.update({'deployed': True, 'image': manifest['candidateImageId'], 'adapterHash': manifest['adapterHash'],
                   'configurationPreserved': True, 'deployedFiles': [SOURCE]})
    (OUT / 'live.json').write_text(json.dumps(result, indent=2))
    print(json.dumps(result), flush=True)


def prepare():
    assert metadata(APP) == {k: STATE[k] for k in ['image', 'configurationHash']}, 'Live application changed'
    baseline = (BACKUP / 'baseline' / SOURCE).read_bytes()
    assert live_hash() == sha(baseline), 'Live adapter changed'
    evidence = json.loads((OUT / 'summary.json').read_text())
    assert not evidence['newFailures'] and evidence['focused']['fail'] == 0
    assert evidence['sourceHash'] == sha((ROOT / SOURCE).read_bytes())
    assert evidence['types'] == evidence['lint'] == 'pass'
    assert evidence['changedLines']['covered'] == evidence['changedLines']['total']
    assert all(m['killed'] and m['propertyKilled'] for m in evidence['mutations'])
    RELEASE.mkdir(exist_ok=False)
    target = RELEASE / 'overlay' / SOURCE
    target.parent.mkdir(parents=True)
    target.write_bytes((ROOT / SOURCE).read_bytes())
    docker('tag', STATE['image'], BASE_IMAGE)
    (RELEASE / 'Dockerfile').write_text(f'FROM {BASE_IMAGE}\nCOPY --chown=node:node overlay/{SOURCE} /app/{SOURCE}\n')
    (RELEASE / 'compose.release.yml').write_text(f'services:\n  app:\n    image: {IMAGE}\n    pull_policy: never\n')
    (RELEASE / 'compose.rollback.yml').write_text(f'services:\n  app:\n    image: {BASE_IMAGE}\n    pull_policy: never\n')
    subprocess.run(['docker', 'build', '--network=none', '--pull=false', '-t', IMAGE, str(RELEASE)], check=True)
    candidate = docker('image', 'inspect', '--format', '{{.Id}}', IMAGE).decode().strip()
    manifest = {'candidateImageId': candidate, 'baseImageId': STATE['image'], 'adapterHash': evidence['sourceHash'],
                'deployedFiles': [SOURCE]}
    (RELEASE / 'manifest.json').write_text(json.dumps(manifest, indent=2))
    # Read resolved environment in memory only; report just whether it matches.
    service = json.loads(subprocess.check_output(compose(RELEASE / 'compose.release.yml') + ['config', '--format', 'json']))['services']['app']
    original = json.loads(docker('inspect', APP))[0]
    current = dict(value.split('=', 1) for value in original['Config']['Env'])
    assert all(current.get(key) == str(value) for key, value in service.get('environment', {}).items()), 'Environment drift'
    assert service['image'] == IMAGE
    print(json.dumps({'prepared': True, 'files': [SOURCE], 'environmentPreserved': True, **manifest}), flush=True)


def apply():
    assert metadata(APP) == {k: STATE[k] for k in ['image', 'configurationHash']}, 'Live application changed'
    manifest = json.loads((RELEASE / 'manifest.json').read_text())
    assert manifest['adapterHash'] == sha((ROOT / SOURCE).read_bytes())
    dependencies = {name: metadata(name) for name in ['mbbs-operator-app-db-1', 'mbbs-operator-app-webhook-worker-1', 'mbbs-operator-app-ollama-1']}
    script = b"""import {query,closeDb} from './src/db.js';
    try {console.log(JSON.stringify((await query(`SELECT json_build_object(
      'specialCreating',(SELECT count(*) FROM sales_special_stock_cases WHERE sales_order_operation_status='creating' OR purchase_order_operation_status='creating'),
      'quantityApplying',(SELECT count(*) FROM sales_special_stock_cases WHERE quantity_review->>'status'='applying'),
      'operatorPosting',(SELECT count(*) FROM operator_netsuite_posting_commands WHERE status IN ('queued','posting','finalizing')),
      'driverExecuting',(SELECT count(*) FROM driver_foreground_action_receipts WHERE status='executing'),
      'regularExecuting',(SELECT count(*) FROM regular_stock_handoffs WHERE status='executing')) AS counts`)).rows[0].counts));}
    finally{await closeDb();}"""
    active = json.loads(docker('exec', '-i', APP, 'node', '--input-type=module', input=script))
    assert not any(active.values()), 'Active work is in progress: ' + json.dumps(active)
    try:
        subprocess.run(compose(RELEASE / 'compose.release.yml') + ['up', '-d', '--no-deps', '--no-build', '--pull', 'never', 'app'], check=True, timeout=60)
        for _attempt in range(20):
            healthy = docker('inspect', '--format', '{{.State.Health.Status}}', APP).decode().strip()
            if healthy == 'healthy':
                break
            time.sleep(2)
        assert healthy == 'healthy'
        verify()
        assert dependencies == {name: metadata(name) for name in dependencies}, 'Other services changed'
    except Exception:
        subprocess.run(compose(RELEASE / 'compose.rollback.yml') + ['up', '-d', '--no-deps', '--no-build', '--pull', 'never', 'app'], check=True, timeout=60)
        raise


if __name__ == '__main__':
    {'prepare': prepare, 'apply': apply, 'verify': verify}[sys.argv[1]]()
