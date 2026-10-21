"""Deploy the three verified pickup assets over the captured live app image."""
import datetime
import importlib.util
import json
import os
import pathlib
import re
import shutil
import subprocess
import sys
import time

ROOT = pathlib.Path(__file__).resolve().parents[2]
STATE = pathlib.Path('/home/ubuntu/operatorapp-deploy-backups/operator-pickup-inline-wait-20261010')
ARTIFACT = ROOT / 'server/test-artifacts/operator-pickup-inline-wait'
spec = importlib.util.spec_from_file_location('pickup_release', ROOT / 'server/tools/operator-to-yard-flow-deploy.py')
core = importlib.util.module_from_spec(spec)
spec.loader.exec_module(core)
core.STATE = STATE
TAG = 'mbbs-operator-app:pickup-inline-wait-20261010'
ROLLBACK = 'mbbs-operator-app:pickup-inline-wait-rollback-20261010'


def manifest():
    return json.loads((ARTIFACT / 'manifest.json').read_text())


def node(program):
    result = core.run(core.DOCKER + ['exec', '-i', '-w', '/app', core.SERVICES['app'], 'node', '--input-type=module'], input=program)
    return json.loads(result)


def build():
    data = manifest()
    log = (ARTIFACT / 'final-checks.log').read_text()
    checks = {key: int(re.findall(rf'^# {key} (\d+)$', log, re.M)[-1]) for key in ['tests', 'pass', 'fail']}
    assert checks['tests'] >= 39 and checks['tests'] == checks['pass'] and checks['fail'] == 0
    assert json.loads((ARTIFACT / 'browser.json').read_text())['passed']
    assert core.inspect(core.SERVICES['app'])['Image'] == data['baseImage']
    for name, change in data['changes'].items():
        assert core.digest(STATE / 'candidate' / name) == change['after']
        assert core.digest(ROOT / 'server' / name) == change['after']
        target = STATE / 'image/overlay' / name
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(STATE / 'candidate' / name, target)
    assert sorted(str(p.relative_to(STATE / 'image/overlay')) for p in (STATE / 'image/overlay').rglob('*') if p.is_file()) == sorted(data['changes'])
    subprocess.run(core.DOCKER + ['tag', data['baseImage'], ROLLBACK], check=True)
    (STATE / 'image/Dockerfile').write_text(f'FROM {ROLLBACK}\nCOPY --chown=node:node overlay/ /app/\n')
    with (ARTIFACT / 'build.log').open('w') as output:
        subprocess.run(core.DOCKER + ['build', '--pull=false', '--network=none', '-t', TAG, str(STATE / 'image')],
                       stdout=output, stderr=subprocess.STDOUT, check=True)
    data['candidateImage'] = core.inspect(TAG)['Id']
    data['checks'] = checks
    core.save(ARTIFACT / 'manifest.json', data)
    for kind, image in [('release', TAG), ('rollback', ROLLBACK)]:
        (STATE / f'compose.{kind}.yml').write_text(f'services:\n  app:\n    image: {image}\n')
    print(json.dumps({'built': True, 'files': list(data['changes']), 'checks': checks}))


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
      console.log(JSON.stringify({localHealth:200,publicHealth:200,publicAssetsVerified:3}));""".replace('FILES', json.dumps({key: value['after'] for key, value in data['changes'].items()}))
    probes = node(program)
    result = {'at': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'appImage': data['candidateImage'],
              'healthy': True, 'configurationPreserved': True, 'otherServicesPreserved': True, **probes}
    core.save(ARTIFACT / 'deployed.json', result)
    print(json.dumps(result))


def deploy():
    data = manifest()
    before = json.loads((STATE / 'before.private.json').read_text())
    assert core.inspect(core.SERVICES['app'])['Image'] == data['baseImage']
    assert core.runtime_hashes(core.SERVICES['app'], list(data['changes'])) == {key: value['before'] for key, value in data['changes'].items()}
    assert json.loads((ARTIFACT / 'browser.json').read_text())['passed'] and data['checks']['fail'] == 0
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
            raise RuntimeError('Pickup UI release did not become healthy')
        verify()
    except Exception:
        subprocess.run(core.compose(before, 'compose.rollback.yml') + ['up', '-d', '--no-deps', '--no-build', 'app'], check=True)
        raise


if __name__ == '__main__':
    os.umask(0o077)
    {'build': build, 'deploy': deploy, 'verify': verify}[sys.argv[1]]()
