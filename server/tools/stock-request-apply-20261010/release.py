"""Release only the stock request Apply and search changes over the current image."""
import datetime
import difflib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import time

ROOT = Path(__file__).resolve().parents[3]
ART = ROOT / 'server/test-artifacts/stock-request-apply-20261010'
STATE = Path('/home/ubuntu/operatorapp-deploy-backups/stock-request-apply-20261010')
spec = importlib.util.spec_from_file_location('release_core', ROOT / 'server/tools/operator-to-yard-flow-deploy.py')
core = importlib.util.module_from_spec(spec)
spec.loader.exec_module(core)
core.STATE = STATE
APP = 'mbbs-operator-app-app-1'
DEPS = ['mbbs-operator-app-db-1', 'mbbs-operator-app-webhook-worker-1', 'mbbs-operator-app-ollama-1']
TAG = 'mbbs-operator-app:stock-request-apply-20261010'
BASE = TAG + '-rollback'
FILES = json.loads((ART / 'files.json').read_text())
CHECK_MODES = ['browser', 'repository']

def save(name, value):
    (ART / name).write_text(json.dumps(value, indent=2) + '\n')

def node(source):
    return json.loads(core.run(core.DOCKER + ['exec', '-i', '-w', '/app', APP, 'node', '--input-type=module'], input=source))

def capture():
    os.umask(0o077)
    STATE.mkdir(mode=0o700, exist_ok=True)
    if (STATE / 'before.private.json').exists():
        before = json.loads((STATE / 'before.private.json').read_text())
        assert core.inspect(APP)['Id'] == before['app']['Id']
    else:
        before = {'app': core.inspect(APP), 'dependencies': {n: core.inspect(n) for n in DEPS}}
        core.save(STATE / 'before.private.json', before)
    baseline = STATE / 'baseline'
    baseline.mkdir(exist_ok=True)
    for name in ['src', 'public', 'migrations', 'package.json', 'package-lock.json']:
        if (baseline / name).exists(): continue
        subprocess.run(core.DOCKER + ['cp', f'{APP}:/app/{name}', str(baseline / name)], check=True)
    subprocess.run(['sudo', '-n', 'chown', '-R', f'{os.getuid()}:{os.getgid()}', str(baseline)], check=True)
    assert core.inspect(APP)['Id'] == before['app']['Id']
    print(json.dumps({'captured': True, 'image': before['app']['Image']}))

def prepare():
    candidate = STATE / 'candidate'
    assert not (ART / 'image.json').exists(), 'Preserve the tested release candidate once built'
    if candidate.exists(): shutil.rmtree(candidate)
    shutil.copytree(STATE / 'baseline', candidate)
    patch = ''
    for name in FILES:
        prior = ART / 'workspace-before' / name
        current = ROOT / 'server' / name
        patch += ''.join(difflib.unified_diff(prior.read_text().splitlines(True), current.read_text().splitlines(True), fromfile='a/' + name, tofile='b/' + name))
    (ART / 'release.patch').write_text(patch)
    applied = subprocess.run(['patch', '--batch', '--forward', '--fuzz=0', '-p1', '-d', str(candidate)], input=patch, text=True, capture_output=True)
    (ART / 'patch.log').write_text(applied.stdout + applied.stderr)
    assert applied.returncode == 0, 'Inspect patch.log; do not release unrelated workspace changes'
    save('manifest.json', {name: {'before': core.digest(STATE / 'baseline' / name), 'after': core.digest(candidate / name)} for name in FILES})
    print(json.dumps({'prepared': True, 'files': len(FILES)}))

def current(before):
    row = core.inspect(APP)
    assert row['Id'] == before['app']['Id'] and row['Image'] == before['app']['Image']
    assert core.runtime_hashes(APP, FILES) == {n: v['before'] for n, v in json.loads((ART / 'manifest.json').read_text()).items()}
    assert all(core.inspect(n)['Id'] == v['Id'] and core.inspect(n)['Image'] == v['Image'] for n, v in before['dependencies'].items())

def build():
    before = json.loads((STATE / 'before.private.json').read_text())
    current(before)
    for mode in CHECK_MODES:
        result = json.loads((ART / f'run-{mode}.json').read_text())
        assert result['exit'] == 0 and result['cleanup']['complete']
    changes = json.loads((ART / 'manifest.json').read_text())
    assert all(core.digest(STATE / 'candidate' / n) == v['after'] for n, v in changes.items())
    image = STATE / 'image'
    for name in FILES:
        target = image / 'overlay' / name
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(STATE / 'candidate' / name, target)
    subprocess.run(core.DOCKER + ['tag', before['app']['Image'], BASE], check=True)
    (image / 'Dockerfile').write_text(f'FROM {BASE}\nCOPY --chown=node:node overlay/ /app/\n')
    with (ART / 'build.log').open('w') as log:
        subprocess.run(core.DOCKER + ['build', '--network=none', '--pull=false', '-t', TAG, str(image)], stdout=log, stderr=subprocess.STDOUT, check=True)
    image_id = core.inspect(TAG)['Id']
    save('image.json', {'tag': TAG, 'image': image_id, 'base': before['app']['Image']})
    for mode, tag in [('release', TAG), ('rollback', BASE)]:
        (STATE / f'compose.{mode}.yml').write_text(f'services:\n  app:\n    image: {tag}\n    pull_policy: never\n')
    print(json.dumps({'built': True, 'image': image_id}))

def ready():
    for _ in range(50):
        row = core.inspect(APP)
        if row['State'].get('Health', {}).get('Status') == 'healthy': return
        time.sleep(1)
    raise RuntimeError('Application did not become healthy')

def verify():
    before = json.loads((STATE / 'before.private.json').read_text())
    row = core.inspect(APP)
    assert row['Image'] == json.loads((ART / 'image.json').read_text())['image']
    assert row['State']['Health']['Status'] == 'healthy'
    assert sorted(row['Config']['Env']) == sorted(before['app']['Config']['Env'])
    # Docker may return mounts in a different order after recreating the app.
    assert sorted(row['Mounts'], key=lambda m: m['Destination']) == sorted(before['app']['Mounts'], key=lambda m: m['Destination'])
    assert core.runtime_hashes(APP, FILES) == {n: v['after'] for n, v in json.loads((ART / 'manifest.json').read_text()).items()}
    assert all(core.inspect(n)['Id'] == v['Id'] and core.inspect(n)['Image'] == v['Image'] for n, v in before['dependencies'].items())
    health = node("""const result={};for(const base of ['http://127.0.0.1:3000','https://test.mbbsoperation.com']){const r=await fetch(base+'/health',{signal:AbortSignal.timeout(15000)});if(r.status!==200||(await r.json()).ok!==true)throw Error(base);result[base]=200;}console.log(JSON.stringify(result));""")
    result = {'deployed': True, 'at': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'image': row['Image'], 'health': health, 'files': len(FILES), 'configurationPreserved': True, 'dependenciesUnchanged': True}
    save('deployed.json', result)
    print(json.dumps(result))

def deploy():
    before = json.loads((STATE / 'before.private.json').read_text())
    current(before)
    configured = json.loads(core.run(core.compose(before, 'compose.release.yml') + ['config', '--format', 'json']))
    core.save(STATE / 'configured.private.json', configured)
    environment = dict(v.split('=', 1) for v in core.inspect(TAG)['Config']['Env'])
    environment.update({k: str(v) for k, v in configured['services']['app'].get('environment', {}).items()})
    assert environment == dict(v.split('=', 1) for v in before['app']['Config']['Env'])
    active = node("""import {query,closeDb} from './src/db.js';try{console.log(JSON.stringify((await query(`SELECT json_build_object('specialCreating',(SELECT count(*) FROM sales_special_stock_cases WHERE sales_order_operation_status='creating' OR purchase_order_operation_status='creating'),'posting',(SELECT count(*) FROM operator_netsuite_posting_commands WHERE status IN ('posting','finalizing')),'driverExecuting',(SELECT count(*) FROM driver_foreground_action_receipts WHERE status='executing')) AS counts`)).rows[0].counts));}finally{await closeDb();}""")
    assert not any(active.values()), 'Wait for active application operations before deployment'
    try:
        with (ART / 'deploy.log').open('w') as log:
            subprocess.run(core.compose(before, 'compose.release.yml') + ['up', '-d', '--no-build', '--no-deps', '--pull', 'never', 'app'], stdout=log, stderr=subprocess.STDOUT, check=True)
        ready()
        verify()
    except BaseException:
        with (ART / 'rollback.log').open('w') as log:
            subprocess.run(core.compose(before, 'compose.rollback.yml') + ['up', '-d', '--no-build', '--no-deps', '--pull', 'never', 'app'], stdout=log, stderr=subprocess.STDOUT, check=True)
        ready()
        raise

if __name__ == '__main__':
    {'capture': capture, 'prepare': prepare, 'build': build, 'deploy': deploy, 'verify': verify}[sys.argv[1]]()
