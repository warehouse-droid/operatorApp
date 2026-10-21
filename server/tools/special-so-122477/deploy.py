"""Deploy only tested SO confirmation changes, with exact independent rollback images."""
import datetime
import importlib.util
import json
import os
import pathlib
import shutil
import subprocess
import sys
import time

ROOT = pathlib.Path(__file__).resolve().parents[3]
STATE = pathlib.Path('/home/ubuntu/operatorapp-deploy-backups/special-so-122477-20261010')
ART = ROOT / 'server/test-artifacts/special-so-122477'
spec = importlib.util.spec_from_file_location('deploy_core', ROOT / 'server/tools/operator-to-yard-flow-deploy.py')
core = importlib.util.module_from_spec(spec)
spec.loader.exec_module(core)
core.STATE = STATE
SERVICES = {'app': 'mbbs-operator-app-app-1', 'webhook-worker': 'mbbs-operator-app-webhook-worker-1'}

def manifest():
    return json.loads((ART / 'manifest.json').read_text())

def sources_checked():
    data = manifest()
    result = json.loads((ART / 'gauntlet.json').read_text())
    assert result['passed']
    assert result['sourceHashes'] == {name: value['after'] for name, value in data['changes'].items()}
    assert json.loads((ART / 'changed-coverage.json').read_text())['uncovered'] == []
    for mode in ['final', 'shuffled']:
        assert json.loads((ART / f'{mode}-summary.json').read_text())['newFailures'] == []
    assert '# pass 1\n# fail 0' in (ART / 'worker-webhook.log').read_text()
    for name, value in data['changes'].items():
        assert core.digest(STATE / 'candidate' / name) == value['after']
        assert core.digest(ROOT / 'server' / name) == value['after']
    return data

def node(program):
    result = core.run(core.DOCKER + ['exec', '-i', '-w', '/app', SERVICES['app'], 'node', '--input-type=module'], input=program)
    return json.loads(result)

def build():
    data = sources_checked()
    releases = {}
    for service, container in SERVICES.items():
        assert core.inspect(container)['Image'] == data['baseImages'][service]
        names = list(data['changes']) if service == 'app' else data['workerChanges']
        candidate = STATE / ('candidate' if service == 'app' else 'candidate-worker')
        image = STATE / 'image' / service
        if image.exists():
            shutil.rmtree(image)
        hashes = {}
        for name in names:
            target = image / 'overlay' / name
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(candidate / name, target)
            hashes[name] = {'before': core.digest(STATE / 'baseline' / service / name), 'after': core.digest(target)}
        base_tag = f'mbbs-operator-app:special-so-confirmation-rollback-{service}-20261010'
        tag = f'mbbs-operator-app:special-so-confirmation-{service}-20261010'
        subprocess.run(core.DOCKER + ['tag', data['baseImages'][service], base_tag], check=True)
        (image / 'Dockerfile').write_text(f'FROM {base_tag}\nCOPY --chown=node:node overlay/ /app/\n')
        with (ART / f'build-{service}.log').open('w') as log:
            subprocess.run(core.DOCKER + ['build', '--network=none', '--pull=false', '-t', tag, str(image)], stdout=log, stderr=subprocess.STDOUT, check=True)
        releases[service] = {'baseImage': data['baseImages'][service], 'image': core.inspect(tag)['Id'], 'tag': tag,
                             'rollbackTag': base_tag, 'hashes': hashes}
    core.save(ART / 'releases.json', releases)
    for mode, key in [('release', 'tag'), ('rollback', 'rollbackTag')]:
        (STATE / f'compose.{mode}.yml').write_text('services:\n' + ''.join(f'  {s}:\n    image: {v[key]}\n    pull_policy: never\n' for s, v in releases.items()))
    print(json.dumps({'built': True, 'services': {s: v['image'] for s, v in releases.items()}}))

def verify():
    before = json.loads((STATE / 'before.private.json').read_text())
    releases = json.loads((ART / 'releases.json').read_text())
    for service, entry in releases.items():
        current = core.inspect(SERVICES[service])
        assert current['Image'] == entry['image'] and current['State']['Running']
        assert dict(v.split('=', 1) for v in current['Config']['Env']) == dict(v.split('=', 1) for v in before[service]['Config']['Env'])
        assert core.runtime_hashes(SERVICES[service], list(entry['hashes'])) == {n: v['after'] for n, v in entry['hashes'].items()}
    assert core.inspect(SERVICES['app'])['State']['Health']['Status'] == 'healthy'
    for service in ['db', 'ollama']:
        current = core.inspect(before[service]['Id'])
        assert current['Id'] == before[service]['Id'] and current['State']['Health']['Status'] == 'healthy'
    # Preserve all operator-facing pickup assets and quantity policy files from the deployed base.
    names = ['public/operator.js', 'public/operator.html', 'public/service-worker.js', 'src/operator-netsuite-posting-quantity.js']
    assert core.runtime_hashes(SERVICES['app'], names) == {n: core.digest(STATE / 'baseline/app' / n) for n in names}
    health = node("""import assert from 'node:assert/strict';
      for(const base of ['http://127.0.0.1:3000','https://test.mbbsoperation.com']) {
        const response=await fetch(base+'/health');assert.equal(response.status,200);assert.equal((await response.json()).ok,true);
      } console.log(JSON.stringify({localHealth:200,publicHealth:200}));""")
    result = {'at': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'healthy': True,
              'services': {s: v['image'] for s, v in releases.items()}, 'configurationPreserved': True,
              'pickupAndRoundingPreserved': True, 'databaseAndOllamaPreserved': True, **health}
    core.save(ART / 'deployed.json', result)
    print(json.dumps(result))

def deploy():
    sources_checked()
    before = json.loads((STATE / 'before.private.json').read_text())
    releases = json.loads((ART / 'releases.json').read_text())
    configured = json.loads(core.run(core.compose(before, 'compose.release.yml') + ['config', '--format', 'json']))
    core.save(STATE / 'compose.private.json', configured)
    for service, entry in releases.items():
        assert core.inspect(SERVICES[service])['Image'] == entry['baseImage']
        assert core.runtime_hashes(SERVICES[service], list(entry['hashes'])) == {n: v['before'] for n, v in entry['hashes'].items()}
        image_env = dict(v.split('=', 1) for v in core.inspect(entry['image'])['Config']['Env'])
        environment = {**image_env, **{k: str(v) for k, v in configured['services'][service].get('environment', {}).items()}}
        assert environment == dict(v.split('=', 1) for v in before[service]['Config']['Env'])
    active = node("""import {query,closeDb} from './src/db.js';
      try {console.log(JSON.stringify((await query(`SELECT json_build_object(
        'specialCreating',(SELECT count(*) FROM sales_special_stock_cases WHERE sales_order_operation_status='creating' OR purchase_order_operation_status='creating'),
        'posting',(SELECT count(*) FROM operator_netsuite_posting_commands WHERE status IN ('posting','finalizing')),
        'driverExecuting',(SELECT count(*) FROM driver_foreground_action_receipts WHERE status='executing')) AS counts`)).rows[0].counts));}
      finally{await closeDb();}""")
    assert not any(active.values()), 'Let current application operations finish before cutover: ' + json.dumps(active)
    try:
        with (ART / 'publish.log').open('w') as log:
            subprocess.run(core.compose(before, 'compose.release.yml') + ['up', '-d', '--no-deps', '--no-build', '--pull', 'never', *SERVICES], stdout=log, stderr=subprocess.STDOUT, check=True, timeout=60)
        for _ in range(50):
            if core.inspect(SERVICES['app'])['State'].get('Health', {}).get('Status') == 'healthy':
                break
            time.sleep(1)
        verify()
    except Exception:
        with (ART / 'rollback.log').open('w') as log:
            subprocess.run(core.compose(before, 'compose.rollback.yml') + ['up', '-d', '--no-deps', '--no-build', '--pull', 'never', *SERVICES], stdout=log, stderr=subprocess.STDOUT, check=True, timeout=60)
        raise

if __name__ == '__main__':
    os.umask(0o077)
    {'build': build, 'deploy': deploy, 'verify': verify}[sys.argv[1]]()
