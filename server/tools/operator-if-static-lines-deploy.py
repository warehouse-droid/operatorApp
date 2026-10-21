"""Deploy the tested current-source fulfillment fix over the captured live app image."""
import datetime
import importlib.util
import json
import os
import pathlib
import shutil
import subprocess
import sys
import time

ROOT = pathlib.Path(__file__).resolve().parents[2]
STATE = pathlib.Path('/home/ubuntu/operatorapp-deploy-backups/operator-if-static-lines-20261010')
ARTIFACT = ROOT / 'server/test-artifacts/operator-if-static-lines'
spec = importlib.util.spec_from_file_location('rounding_release', ROOT / 'server/tools/operator-to-yard-flow-deploy.py')
core = importlib.util.module_from_spec(spec)
spec.loader.exec_module(core)
core.STATE = STATE
TAG = 'mbbs-operator-app:if-static-lines-20261010'
ROLLBACK = 'mbbs-operator-app:if-static-lines-rollback-20261010'


def manifest():
    return json.loads((ARTIFACT / 'manifest.json').read_text())


def node(program):
    result = core.run(core.DOCKER + ['exec', '-i', '-w', '/app', core.SERVICES['app'],
                                   'node', '--input-type=module'], input=program)
    return json.loads(result)


def checked_sources():
    data = manifest()
    evidence = json.loads((ARTIFACT / 'gauntlet.json').read_text())
    assert evidence['passed']
    assert json.loads((ARTIFACT / 'changed-coverage.json').read_text())['uncovered'] == []
    assert evidence['sourceHashes'] == {key: value['after'] for key, value in data['changes'].items()}
    for kind in ['final', 'shuffled']:
        report = json.loads((ARTIFACT / f'{kind}-summary.json').read_text())
        assert report['tests'] >= 660 and report['newFailures'] == [] and report['failedFiles'] == 0
    assert json.loads((ARTIFACT / 'type-comparison.json').read_text())['newTypes'] == []
    assert json.loads((ARTIFACT / 'lint-comparison.json').read_text())['newLint'] == []
    mutations = json.loads((ARTIFACT / 'mutations/results.json').read_text())
    assert len(mutations) == 14 and all(row['killed'] for row in mutations)
    for name, change in data['changes'].items():
        assert core.digest(STATE / 'candidate' / name) == change['after']
        assert core.digest(ROOT / 'server' / name) == change['workspaceAfter']
    return data


def build():
    data = checked_sources()
    assert core.inspect(core.SERVICES['app'])['Image'] == data['baseImage']
    overlay = STATE / 'image/overlay'
    if overlay.exists():
        shutil.rmtree(overlay)
    for name in data['changes']:
        target = overlay / name
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(STATE / 'candidate' / name, target)
    assert sorted(str(p.relative_to(overlay)) for p in overlay.rglob('*') if p.is_file()) == sorted(data['changes'])
    subprocess.run(core.DOCKER + ['tag', data['baseImage'], ROLLBACK], check=True)
    (STATE / 'image/Dockerfile').write_text(f'FROM {ROLLBACK}\nCOPY --chown=node:node overlay/ /app/\n')
    with (ARTIFACT / 'build.log').open('w') as output:
        subprocess.run(core.DOCKER + ['build', '--pull=false', '--network=none', '-t', TAG, str(STATE / 'image')],
                       stdout=output, stderr=subprocess.STDOUT, check=True)
    data['candidateImage'] = core.inspect(TAG)['Id']
    core.save(ARTIFACT / 'manifest.json', data)
    for kind, image in [('release', TAG), ('rollback', ROLLBACK)]:
        (STATE / f'compose.{kind}.yml').write_text(f'services:\n  app:\n    image: {image}\n    pull_policy: never\n')
    print(json.dumps({'built': True, 'files': len(data['changes']), 'image': data['candidateImage']}))


def verify():
    data = manifest()
    before = json.loads((STATE / 'before.private.json').read_text())
    app = core.inspect(core.SERVICES['app'])
    assert app['Image'] == data['candidateImage'] and app['State']['Health']['Status'] == 'healthy'
    assert dict(v.split('=', 1) for v in app['Config']['Env']) == dict(v.split('=', 1) for v in before['app']['Config']['Env'])
    assert core.runtime_hashes(core.SERVICES['app'], list(data['changes'])) == {key: value['after'] for key, value in data['changes'].items()}
    for service in ['db', 'ollama', 'webhook-worker']:
        current = core.inspect(before[service]['Id'])
        assert current['State']['Running'] and current['Id'] == before[service]['Id']
    assets = {name: core.digest(STATE / 'candidate' / name)
              for name in ['public/operator.js', 'public/operator.html', 'public/service-worker.js']}
    program = """import assert from 'node:assert/strict';import crypto from 'node:crypto';
      const files=FILES;
      for(const base of ['http://127.0.0.1:3000','https://test.mbbsoperation.com']){
        for(const [name,expected] of Object.entries(files)){
          const response=await fetch(base+'/'+name.replace('public/',''),{headers:{'Cache-Control':'no-cache'}});
          assert.equal(response.status,200);
          assert.equal(crypto.createHash('sha256').update(Buffer.from(await response.arrayBuffer())).digest('hex'),expected);
        }
        const response=await fetch(base+'/health');assert.equal(response.status,200);assert.equal((await response.json()).ok,true);
      }
      console.log(JSON.stringify({localHealth:200,publicHealth:200,pickupAssetsVerified:3}));""".replace('FILES', json.dumps(assets))
    result = {'at': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'appImage': data['candidateImage'],
              'healthy': True, 'configurationPreserved': True, 'otherServicesPreserved': True, **node(program)}
    core.save(ARTIFACT / 'deployed.json', result)
    print(json.dumps(result))


def deploy():
    data = checked_sources()
    before = json.loads((STATE / 'before.private.json').read_text())
    assert core.inspect(core.SERVICES['app'])['Image'] == data['baseImage']
    assert core.runtime_hashes(core.SERVICES['app'], list(data['changes'])) == {key: value['before'] for key, value in data['changes'].items()}
    configured = json.loads(core.run(core.compose(before, 'compose.release.yml') + ['config', '--format', 'json']))
    core.save(STATE / 'compose.private.json', configured)
    image_env = dict(v.split('=', 1) for v in core.inspect(TAG)['Config']['Env'])
    environment = {**image_env, **{key: str(value) for key, value in configured['services']['app'].get('environment', {}).items()}}
    assert environment == dict(v.split('=', 1) for v in before['app']['Config']['Env'])
    active = node("""import {query,closeDb} from './src/db.js';
      try{console.log(JSON.stringify((await query("SELECT COUNT(*)::int AS count FROM operator_netsuite_posting_commands WHERE status IN ('posting','finalizing')")).rows[0]));}finally{await closeDb();}""")
    assert active['count'] == 0, 'Wait for active posting to finish before cutover.'
    try:
        subprocess.run(core.compose(before, 'compose.release.yml') + ['up', '-d', '--no-deps', '--no-build', 'app'], check=True)
        for _ in range(55):
            app = core.inspect(core.SERVICES['app'])
            if app['Image'] == data['candidateImage'] and app['State'].get('Health', {}).get('Status') == 'healthy':
                break
            time.sleep(1)
        else:
            raise RuntimeError('Fulfillment-line release did not become healthy')
        verify()
    except Exception:
        subprocess.run(core.compose(before, 'compose.rollback.yml') + ['up', '-d', '--no-deps', '--no-build', 'app'], check=True)
        raise


def live():
    program = (ROOT / 'server/tools/operator-if-static-lines-live.mjs').read_text().replace("from '../src/", "from './src/")
    result = node(program)
    core.save(ARTIFACT / 'live.json', result)
    print(json.dumps(result))


def cleanup():
    expected = ['mbbs-operator-app-app-1', 'mbbs-operator-app-db-1',
                'mbbs-operator-app-webhook-worker-1', 'mbbs-operator-app-ollama-1']
    def names(command):
        return sorted(core.run(core.DOCKER + command).strip().splitlines())
    running = names(['ps', '--format', '{{.Names}}'])
    all_containers = names(['ps', '-a', '--format', '{{.Names}}'])
    networks = [name for name in names(['network', 'ls', '--format', '{{.Name}}'])
                if name.startswith('mbbs-to-yard-test-')]
    volumes = [name for name in names(['volume', 'ls', '--format', '{{.Name}}'])
               if name.startswith('mbbs-to-yard-test-')]
    assert running == all_containers == sorted(expected), 'Disposable containers remain'
    assert networks == volumes == [], 'Disposable test storage or networks remain'
    for name in expected:
        current = core.inspect(name)
        assert current['State']['Running']
        if name != 'mbbs-operator-app-webhook-worker-1':
            assert current['State']['Health']['Status'] == 'healthy'
    result = {'at': datetime.datetime.now(datetime.timezone.utc).isoformat(),
              'running': running, 'all': all_containers, 'allTestContainersGone': True,
              'unusedTestNetworks': networks, 'testVolumes': volumes, 'productionHealthy': True}
    core.save(ARTIFACT / 'cleanup.json', result)
    print(json.dumps(result))


if __name__ == '__main__':
    os.umask(0o077)
    {'build': build, 'deploy': deploy, 'verify': verify, 'live': live, 'cleanup': cleanup}[sys.argv[1]]()
