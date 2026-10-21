"""Capture, build, deploy, and verify only the four pickup quantity fix files."""
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

ROOT = Path(__file__).resolve().parents[2]
SERVER = ROOT / 'server'
STATE = SERVER / 'deployments/pickup-remaining-packs-20261015'
ARTIFACT = SERVER / 'test-artifacts/pickup-remaining-packs-20261015'
FILES = ['src/delivery-repository.js', 'public/operator.js', 'public/operator.html', 'public/service-worker.js']
TAG = 'mbbs-operator-app:pickup-remaining-packs-20261015'
ROLLBACK = 'mbbs-operator-app:pickup-remaining-packs-rollback-20261015'
spec = importlib.util.spec_from_file_location('release_helpers', SERVER / 'tools/operator-to-yard-flow-deploy.py')
core = importlib.util.module_from_spec(spec)
spec.loader.exec_module(core)
core.STATE = STATE
CONTAINERS = {'app': 'mbbs-operator-app-app-1', 'db': 'mbbs-operator-app-db-1',
              'ollama': 'mbbs-operator-app-ollama-1', 'webhook-worker': 'mbbs-operator-app-webhook-worker-1'}


def node(source):
    return json.loads(core.run(core.DOCKER + ['exec', '-i', '-w', '/app', CONTAINERS['app'],
                                             'node', '--input-type=module'], input=source))


def capture():
    current = {name: core.inspect(container) for name, container in CONTAINERS.items()}
    before = json.loads((STATE / 'before.private.json').read_text()) if (STATE / 'before.private.json').exists() else current
    assert all(current[name]['Id'] == before[name]['Id'] for name in CONTAINERS), 'Live release changed during capture.'
    subprocess.run(['sudo', '-n', 'chown', '-R', f'{os.getuid()}:{os.getgid()}', str(STATE / 'before')], check=True)
    actual = core.runtime_hashes(CONTAINERS['app'], FILES)
    assert actual == {name: core.digest(STATE / 'before' / name) for name in FILES}, 'Live sources changed.'
    core.save(STATE / 'before.private.json', before)
    for name in ['src', 'public']:
        subprocess.run(core.DOCKER + ['cp', f'{CONTAINERS["app"]}:/app/{name}/.', str(STATE / 'before' / name)], check=True)
    subprocess.run(['sudo', '-n', 'chown', '-R', f'{os.getuid()}:{os.getgid()}', str(STATE / 'before')], check=True)
    shutil.copytree(STATE / 'before', STATE / 'candidate')
    changes = {}
    for name in FILES:
        shutil.copy2(SERVER / name, STATE / 'candidate' / name)
        changes[name] = {'before': actual[name], 'after': core.digest(STATE / 'candidate' / name)}
    patch = ''.join(''.join(difflib.unified_diff((STATE / 'before' / name).read_text().splitlines(True),
        (STATE / 'candidate' / name).read_text().splitlines(True), fromfile='a/' + name, tofile='b/' + name)) for name in FILES)
    (ARTIFACT / 'change.patch').write_text(patch)
    core.save(ARTIFACT / 'manifest.json', {'baseImage': before['app']['Image'], 'changes': changes})
    print(json.dumps({'captured': True, 'changedFiles': FILES}))


def checked():
    data = json.loads((ARTIFACT / 'manifest.json').read_text())
    for name, hashes in data['changes'].items():
        assert core.digest(STATE / 'candidate' / name) == hashes['after']
        assert core.digest(SERVER / name) == hashes['after'], f'Workspace changed: {name}'
    return data


def build():
    data = checked()
    assert '# fail 0\n' in (ARTIFACT / 'candidate.log').read_text()
    assert core.inspect(CONTAINERS['app'])['Image'] == data['baseImage'], 'Live release changed; rebase first.'
    overlay = STATE / 'image/overlay'
    for name in FILES:
        target = overlay / name
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(STATE / 'candidate' / name, target)
    assert sorted(str(p.relative_to(overlay)) for p in overlay.rglob('*') if p.is_file()) == sorted(FILES)
    subprocess.run(core.DOCKER + ['tag', data['baseImage'], ROLLBACK], check=True)
    (STATE / 'image/Dockerfile').write_text(f'FROM {ROLLBACK}\nCOPY --chown=node:node overlay/ /app/\n')
    with (ARTIFACT / 'build.log').open('w') as output:
        subprocess.run(core.DOCKER + ['build', '--pull=false', '--network=none', '-t', TAG, str(STATE / 'image')],
                       stdout=output, stderr=subprocess.STDOUT, check=True)
    data['candidateImage'] = core.inspect(TAG)['Id']
    core.save(ARTIFACT / 'manifest.json', data)
    for kind, image in [('release', TAG), ('rollback', ROLLBACK)]:
        (STATE / f'compose.{kind}.yml').write_text(f'services:\n  app:\n    image: {image}\n    pull_policy: never\n')
    print(json.dumps({'built': True, 'image': TAG, 'files': len(FILES)}))


def verify():
    data = checked()
    before = json.loads((STATE / 'before.private.json').read_text())
    app = core.inspect(CONTAINERS['app'])
    assert app['Image'] == data['candidateImage']
    assert app['State']['Health']['Status'] == 'healthy'
    assert dict(v.split('=', 1) for v in app['Config']['Env']) == dict(v.split('=', 1) for v in before['app']['Config']['Env'])
    assert core.runtime_hashes(CONTAINERS['app'], FILES) == {name: hashes['after'] for name, hashes in data['changes'].items()}
    for name in ['db', 'ollama', 'webhook-worker']:
        current = core.inspect(CONTAINERS[name])
        assert current['Id'] == before[name]['Id'] and current['State']['Running']
    assets = {name.removeprefix('public/'): data['changes'][name]['after'] for name in FILES if name.startswith('public/')}
    result = node("""
      import assert from 'node:assert/strict'; import crypto from 'node:crypto';
      const assets=ASSETS;
      for(const base of ['http://127.0.0.1:3000','https://test.mbbsoperation.com']) {
        const health=await fetch(base+'/health'); assert.equal(health.status,200); assert.equal((await health.json()).ok,true);
        for(const [path,hash] of Object.entries(assets)) {
          const response=await fetch(base+'/'+path,{headers:{'Cache-Control':'no-cache'}}); assert.equal(response.status,200);
          assert.equal(crypto.createHash('sha256').update(Buffer.from(await response.arrayBuffer())).digest('hex'),hash);
        }
      }
      console.log(JSON.stringify({localHealth:200,publicHealth:200,assetsVerified:3}));
    """.replace('ASSETS', json.dumps(assets)))
    core.save(ARTIFACT / 'deployed.json', {'at': datetime.datetime.now(datetime.timezone.utc).isoformat(),
        'appImage': app['Image'], 'configurationUnchanged': True, 'otherContainersUnchanged': True, **result})
    print(json.dumps({'deployed': True, **result}))


def deploy():
    data = checked()
    before = json.loads((STATE / 'before.private.json').read_text())
    assert core.inspect(CONTAINERS['app'])['Image'] == data['baseImage'], 'Live release changed; rebase first.'
    assert core.runtime_hashes(CONTAINERS['app'], FILES) == {name: value['before'] for name, value in data['changes'].items()}
    configured = json.loads(core.run(core.compose(before, 'compose.release.yml') + ['config', '--format', 'json']))
    core.save(STATE / 'compose.private.json', configured)
    image_env = dict(v.split('=', 1) for v in core.inspect(TAG)['Config']['Env'])
    environment = {**image_env, **{k: str(v) for k, v in configured['services']['app'].get('environment', {}).items()}}
    assert environment == dict(v.split('=', 1) for v in before['app']['Config']['Env'])
    active = node("""import {query,closeDb} from './src/db.js';
      try{console.log(JSON.stringify((await query("SELECT COUNT(*)::int AS count FROM operator_netsuite_posting_commands WHERE status IN ('posting','finalizing')")).rows[0]));}finally{await closeDb();}""")
    assert active['count'] == 0, 'A posting operation is active; retry cutover after it finishes.'
    try:
        subprocess.run(core.compose(before, 'compose.release.yml') + ['up', '-d', '--no-deps', '--no-build', 'app'], check=True)
        for _ in range(30):
            if core.inspect(CONTAINERS['app'])['State'].get('Health', {}).get('Status') == 'healthy':
                verify()
                return
            time.sleep(1)
        raise RuntimeError('App did not become healthy')
    except Exception:
        subprocess.run(core.compose(before, 'compose.rollback.yml') + ['up', '-d', '--no-deps', '--no-build', 'app'], check=True)
        raise


if __name__ == '__main__':
    os.umask(0o077)
    {'capture': capture, 'build': build, 'deploy': deploy, 'verify': verify}[sys.argv[1]]()
