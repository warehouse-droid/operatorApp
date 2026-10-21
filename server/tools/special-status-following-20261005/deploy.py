"""Deploy the tested status display/cache overlay with automatic image rollback."""
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import time

ROOT = Path(__file__).resolve().parents[2]
DIR = ROOT / 'tools/special-status-following-20261005'
OUT = ROOT / 'test-artifacts/special-status-following-20261005'
RELEASE = Path('/home/ubuntu/operatorapp-investigations/special-status-following-20261005')
APP = 'mbbs-operator-app-app-1'
TAG = 'mbbs-operator-app:special-status-following-20261005'
BASE = 'mbbs-operator-app:special-status-following-base-20261005'
FILES = ['src/special-stock-status-refresh.js', 'src/special-stock-logistics.js', 'src/server.js',
         'src/special-stock-request-repository.js', 'public/special-stock-case-status.js',
         'public/special-stock-queue.js', 'public/scm-special-stock-requests.js', 'public/sales-special-stock-requests.js']


def docker(*args, **kwargs):
    return subprocess.check_output(['docker', *args], **kwargs)


def sha(data):
    return hashlib.sha256(data).hexdigest()


def metadata(name):
    info = json.loads(docker('inspect', name))[0]
    config = {key: value for key, value in info['Config'].items() if key not in ['Image', 'Labels', 'Hostname']}
    config['Env'] = sorted(config['Env'])
    return {'image': info['Image'], 'configurationHash': sha(json.dumps({'Config': config, 'HostConfig': info['HostConfig']}, sort_keys=True).encode())}


def live_hashes():
    script = "const fs=require('fs'),c=require('crypto');console.log(JSON.stringify(Object.fromEntries(process.argv.slice(1).map(f=>[f,fs.existsSync('/app/'+f)?c.createHash('sha256').update(fs.readFileSync('/app/'+f)).digest('hex'):null]))))"
    return json.loads(docker('exec', APP, 'node', '-e', script, *FILES))


def compose(override):
    state = json.loads((RELEASE / 'runtime.json').read_text())
    labels = state['compose']
    args = ['sudo', '-n', 'docker', 'compose', '--project-name', labels['com.docker.compose.project'],
            '--project-directory', labels['com.docker.compose.project.working_dir'],
            '--env-file', labels['com.docker.compose.project.environment_file']]
    for filename in labels['com.docker.compose.project.config_files'].split(','):
        args += ['-f', filename]
    return args + ['-f', str(RELEASE / override)]


def prepare():
    evidence = json.loads((OUT / 'summary.json').read_text())
    db = json.loads((OUT / 'db-summary.json').read_text())
    coverage = json.loads((OUT / 'changed-line-coverage.json').read_text())
    browser = json.loads((OUT / 'browser-summary.json').read_text())
    assert not evidence['newFailures'] and not evidence['focused']['fail'] and not db['fail']
    assert coverage['allExecuted'] and len(browser['checks']) == 4
    assert all(check['physicalStatuses'] and check['actualTimes'] and check['previewsCorrect'] and not check['pageErrors'] for check in browser['checks'])
    assert evidence['types']['new'] == 0 and evidence['lint'] == 'pass'
    assert all(m['killed'] and m['propertyKilled'] for m in evidence['mutations'])
    assert evidence['manifest'] == {name: sha((ROOT / name).read_bytes()) for name in FILES}
    RELEASE.mkdir(exist_ok=False)
    info = json.loads(docker('inspect', APP))[0]
    keys = ['project', 'working_dir', 'environment_file', 'config_files']
    state = {**metadata(APP), 'sourceHashes': live_hashes(),
             'compose': {f'com.docker.compose.project.{key}' if key != 'project' else 'com.docker.compose.project':
                         info['Config']['Labels'][f'com.docker.compose.project.{key}' if key != 'project' else 'com.docker.compose.project'] for key in keys}}
    for name, value in state['sourceHashes'].items():
        if value is not None:
            assert value == sha((DIR / 'baseline' / name).read_bytes()), 'Live source changed: ' + name
    (RELEASE / 'runtime.json').write_text(json.dumps(state, indent=2))
    docker('tag', state['image'], BASE)
    for name in FILES:
        target = RELEASE / 'overlay' / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes((ROOT / name).read_bytes())
    copy_lines = ''.join(f'COPY --chown=node:node overlay/{name} /app/{name}\n' for name in FILES)
    (RELEASE / 'Dockerfile').write_text('FROM ' + BASE + '\n' + copy_lines)
    (RELEASE / 'release.yml').write_text(f'services:\n  app:\n    image: {TAG}\n    pull_policy: never\n')
    (RELEASE / 'rollback.yml').write_text(f'services:\n  app:\n    image: {BASE}\n    pull_policy: never\n')
    subprocess.run(['docker', 'build', '--network=none', '--pull=false', '-t', TAG, str(RELEASE)], check=True)
    image = docker('image', 'inspect', '--format', '{{.Id}}', TAG).decode().strip()
    service = json.loads(subprocess.check_output(compose('release.yml') + ['config', '--format', 'json']))['services']['app']
    current = dict(value.split('=', 1) for value in info['Config']['Env'])
    assert all(current.get(key) == str(value) for key, value in service.get('environment', {}).items())
    manifest = {'candidateImageId': image, 'sourceHashes': evidence['manifest'], 'baseImageId': state['image']}
    (RELEASE / 'manifest.json').write_text(json.dumps(manifest, indent=2))
    print(json.dumps({'prepared': True, 'environmentPreserved': True, **manifest}), flush=True)


def verify(mode='verify'):
    manifest = json.loads((RELEASE / 'manifest.json').read_text())
    state = json.loads((RELEASE / 'runtime.json').read_text())
    assert metadata(APP) == {'image': manifest['candidateImageId'], 'configurationHash': state['configurationHash']}
    assert live_hashes() == manifest['sourceHashes']
    result = json.loads(docker('exec', '-i', '-e', 'SPECIAL_STATUS_REPAIR_MODE=' + mode, '-w', '/app',
                              APP, 'node', '--input-type=module', input=(DIR / 'verify-live.mjs').read_bytes()))
    result.update({'image': manifest['candidateImageId'], 'configurationPreserved': True, 'deployedFiles': FILES})
    (OUT / ('live-' + mode + '.json')).write_text(json.dumps(result, indent=2))
    print(json.dumps(result), flush=True)


def apply():
    state = json.loads((RELEASE / 'runtime.json').read_text())
    assert metadata(APP) == {key: state[key] for key in ['image', 'configurationHash']}
    assert live_hashes() == state['sourceHashes']
    others = {name: metadata(name) for name in ['mbbs-operator-app-db-1', 'mbbs-operator-app-webhook-worker-1', 'mbbs-operator-app-ollama-1']}
    script = b"""import {query,closeDb} from './src/db.js';try{console.log(JSON.stringify((await query(`SELECT json_build_object(
      'specialCreating',(SELECT count(*) FROM sales_special_stock_cases WHERE sales_order_operation_status='creating' OR purchase_order_operation_status='creating'),
      'quantityApplying',(SELECT count(*) FROM sales_special_stock_cases WHERE quantity_review->>'status'='applying'),
      'operatorPosting',(SELECT count(*) FROM operator_netsuite_posting_commands WHERE status IN ('queued','posting','finalizing')),
      'driverExecuting',(SELECT count(*) FROM driver_foreground_action_receipts WHERE status='executing'),
      'regularExecuting',(SELECT count(*) FROM regular_stock_handoffs WHERE status='executing')) AS counts`)).rows[0].counts));}finally{await closeDb();}"""
    active = json.loads(docker('exec', '-i', '-w', '/app', APP, 'node', '--input-type=module', input=script))
    assert not any(active.values()), 'Active operations: ' + json.dumps(active)
    try:
        subprocess.run(compose('release.yml') + ['up', '-d', '--no-deps', '--no-build', '--pull', 'never', 'app'], check=True, timeout=60)
        healthy = 'starting'
        for _ in range(25):
            healthy = docker('inspect', '--format', '{{.State.Health.Status}}', APP).decode().strip()
            if healthy == 'healthy':
                break
            time.sleep(2)
        assert healthy == 'healthy'
        verify('preview')
        verify('apply')
        verify()
        assert others == {name: metadata(name) for name in others}
    except Exception:
        subprocess.run(compose('rollback.yml') + ['up', '-d', '--no-deps', '--no-build', '--pull', 'never', 'app'], check=True, timeout=60)
        raise


if __name__ == '__main__':
    {'prepare': prepare, 'apply': apply, 'verify': verify}[sys.argv[1]]()
