"""Release the verified Pickup/Delivery physical-balance fix over the live image."""
import datetime
import hashlib
import importlib.util
import json
from pathlib import Path
import shutil
import subprocess
import sys
import time

SERVER = Path(__file__).resolve().parents[1]
ROOT = SERVER.parent
OUT = SERVER / 'test-artifacts/regular-stock-remaining-20261016'
RELEASE = SERVER / 'deployments/regular-stock-remaining-20261016'
APP = 'mbbs-operator-app-app-1'
DEPENDENCIES = ['mbbs-operator-app-db-1', 'mbbs-operator-app-webhook-worker-1', 'mbbs-operator-app-ollama-1']
IMAGE = 'mbbs-operator-app:regular-stock-remaining-20261016'
ROLLBACK = 'mbbs-operator-app:rollback-regular-stock-remaining-20261016'
FILES = json.loads((OUT / 'baseline/files.json').read_text())
spec = importlib.util.spec_from_file_location('remaining_release_core', SERVER / 'tools/operator-display-settings-deploy.py')
core = importlib.util.module_from_spec(spec)
spec.loader.exec_module(core)
docker, metadata = core.docker, core.metadata


def digest(value):
    return hashlib.sha256(value).hexdigest()


def save(name, value):
    (RELEASE / name).write_text(json.dumps(value, indent=2) + '\n')


def manifest():
    return json.loads((RELEASE / 'manifest.json').read_text())


def resource_policy():
    host = json.loads(docker('inspect', APP))[0]['HostConfig']
    keys = ['Memory', 'MemorySwap', 'MemoryReservation', 'NanoCpus', 'CpuShares',
            'CpuPeriod', 'CpuQuota', 'CpusetCpus', 'PidsLimit', 'CgroupParent',
            'ReadonlyRootfs', 'Init', 'SecurityOpt', 'CapAdd', 'CapDrop', 'Tmpfs']
    return {key: host.get(key) for key in keys}


def compose(state, filename):
    args = ['sudo', '-n', 'docker', 'compose', '-p', 'mbbs-operator-app']
    for config in state['app']['configFiles'].split(','):
        args += ['-f', config]
    return args + ['-f', str(RELEASE / filename)]


def current(state):
    assert metadata(APP) == state['app'], 'Live app changed: recapture before deployment'
    assert [metadata(name) for name in DEPENDENCIES] == state['dependencies'], 'Dependency changed'
    assert resource_policy() == state['resourcePolicy']
    for file in FILES:
        assert digest(docker('exec', APP, 'cat', '/app/' + file)) == state['before'][file], file
        assert digest((RELEASE / 'stage' / file).read_bytes()) == state['after'][file], file
        assert digest((RELEASE / 'candidate-runtime' / file).read_bytes()) == state['after'][file], file


def configuration_preflight(state):
    before = json.loads(subprocess.check_output(compose(state, 'compose.rollback.yml') + ['config', '--format', 'json'], cwd=ROOT))
    after = json.loads(subprocess.check_output(compose(state, 'compose.release.yml') + ['config', '--format', 'json'], cwd=ROOT))
    before['services']['app'].pop('image')
    assert after['services']['app'].pop('image') == IMAGE
    assert before == after, 'Unexpected Compose configuration changes'
    resolved = after['services']['app']
    image_config = json.loads(docker('image', 'inspect', IMAGE))[0]['Config']
    runtime_config = json.loads(docker('inspect', APP))[0]['Config']
    expected_env = dict(entry.split('=', 1) for entry in image_config['Env'])
    expected_env.update({key: str(value) for key, value in resolved.get('environment', {}).items()})
    assert expected_env == dict(entry.split('=', 1) for entry in runtime_config['Env']), 'Environment would change'
    for field, option in [('Cmd', 'command'), ('Entrypoint', 'entrypoint'), ('User', 'user'), ('WorkingDir', 'working_dir')]:
        expected = resolved.get(option) if resolved.get(option) is not None else image_config.get(field)
        assert expected == runtime_config.get(field), field


def prepare():
    RELEASE.mkdir(parents=True, exist_ok=False)
    state = {'app': metadata(APP), 'dependencies': [metadata(name) for name in DEPENDENCIES],
             'resourcePolicy': resource_policy(), 'before': {}, 'after': {}, 'image': IMAGE}
    evidence = json.loads((OUT / 'final/report.json').read_text())
    assert evidence['layers'][0]['tests'] == evidence['layers'][0]['passed'] == 22
    candidate = RELEASE / 'candidate-runtime'
    candidate.mkdir()
    for name in ['src', 'public', 'migrations', 'package.json']:
        docker('cp', APP + ':/app/' + name, str(candidate / name))
    subprocess.run(['sudo', '-n', 'chown', '-R', '1000:1000', str(candidate)], check=True)
    (candidate / 'test').symlink_to(OUT / 'snapshot/test', target_is_directory=True)
    (candidate / 'contracts').symlink_to(OUT / 'snapshot/contracts', target_is_directory=True)
    for file in FILES:
        live = (candidate / file).read_bytes()
        assert live == (OUT / 'baseline' / file).read_bytes(), 'Live baseline differs: ' + file
        desired = (OUT / 'snapshot' / file).read_bytes()
        assert digest(desired) == evidence['sourceHashes'][file], 'Untested candidate: ' + file
        assert desired == (SERVER / file).read_bytes(), 'Workspace changed: ' + file
        state['before'][file], state['after'][file] = digest(live), digest(desired)
        for folder, content in [('before', live), ('stage', desired)]:
            target = RELEASE / folder / file
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(content)
        (candidate / file).write_bytes(desired)
    current(state)
    save('manifest.json', state)
    docker('tag', state['app']['imageId'], ROLLBACK)
    (RELEASE / 'stage/Dockerfile').write_text('FROM ' + ROLLBACK + '\n' + ''.join(
        'COPY --chown=node:node ' + file + ' /app/' + file + '\n' for file in FILES))
    (RELEASE / 'compose.release.yml').write_text('services:\n  app:\n    image: ' + IMAGE + '\n')
    (RELEASE / 'compose.rollback.yml').write_text('services:\n  app:\n    image: ' + state['app']['imageId'] + '\n')
    with (RELEASE / 'build.log').open('wb') as log:
        subprocess.run(['sudo', '-n', 'docker', 'build', '--pull=false', '--network=none', '-t', IMAGE, str(RELEASE / 'stage')],
                       stdout=log, stderr=subprocess.STDOUT, check=True, timeout=120)
    finish_prepare()


def finish_prepare():
    state = manifest()
    current(state)
    state['candidateImageId'] = docker('image', 'inspect', '--format', '{{.Id}}', IMAGE).decode().strip()
    configuration_preflight(state)
    save('manifest.json', state)
    print(json.dumps({'prepared': True, 'image': IMAGE, 'files': len(FILES), 'configurationPreserved': True}), flush=True)


def verify(state):
    core.ready(state['candidateImageId'])
    for _ in range(60):
        row = json.loads(docker('inspect', APP))[0]
        if row['State'].get('Health', {}).get('Status') == 'healthy':
            break
        time.sleep(0.5)
    assert row['Image'] == state['candidateImageId'] and row['State']['Health']['Status'] == 'healthy'
    assert row['RestartCount'] == 0
    assert metadata(APP)['configuration'] == state['app']['configuration']
    assert resource_policy() == state['resourcePolicy']
    assert [metadata(name) for name in DEPENDENCIES] == state['dependencies']
    for file in FILES:
        assert digest(docker('exec', APP, 'cat', '/app/' + file)) == state['after'][file], file
    probe = """import assert from 'node:assert/strict';import crypto from 'node:crypto';
      const expected=EXPECTED,probes=[];
      for(const base of ['http://127.0.0.1:3000','https://test.mbbsoperation.com']) {
        const health=await fetch(base+'/health',{signal:AbortSignal.timeout(15000)});
        assert.equal(health.status,200);assert.equal((await health.json()).ok,true);
        const asset=await fetch(base+'/regular-stock-delivery.js',{
          headers:{'Cache-Control':'no-cache'},signal:AbortSignal.timeout(15000)});
        assert.equal(asset.status,200);
        assert.equal(crypto.createHash('sha256').update(Buffer.from(await asset.arrayBuffer())).digest('hex'),expected);
        probes.push({base,health:200,assetHashVerified:true});
      }console.log(JSON.stringify(probes));
    """.replace('EXPECTED', json.dumps(state['after']['public/regular-stock-delivery.js']))
    probes = json.loads(docker('exec', '-i', APP, 'node', '--input-type=module', input=probe.encode()))
    result = {'deployed': True, 'at': datetime.datetime.now(datetime.timezone.utc).isoformat(),
              'image': IMAGE, 'imageId': state['candidateImageId'], 'rollbackImage': ROLLBACK,
              'runtimeHashes': state['after'], 'configurationPreserved': True, 'dependenciesUnchanged': True,
              'databaseMigrations': 0, 'manualNetSuiteWrites': 0, 'health': 'healthy', 'probes': probes,
              'dockerPs': docker('ps', '--format', '{{.Names}} {{.Status}}').decode(),
              'dockerPsA': docker('ps', '-a', '--format', '{{.Names}} {{.Status}}').decode()}
    save('deployment-result.json', result)
    shutil.copy2(RELEASE / 'deployment-result.json', OUT / 'deployment-result.json')
    print(json.dumps({key: result[key] for key in ['deployed', 'at', 'image', 'configurationPreserved', 'health', 'probes']}), flush=True)


def apply():
    state = manifest()
    current(state)
    assert not (RELEASE / 'deployment-result.json').exists()
    checks = (OUT / 'deployment-check/checks.log').read_text()
    assert '# tests 23\n' in checks and '# pass 23\n' in checks and '# fail 0\n' in checks, 'Release tests required'
    assert 'Removed' in (OUT / 'deployment-check/teardown.log').read_text(), 'Test cleanup required'
    built = json.loads((RELEASE / 'image-verification.json').read_text())
    assert built['imageId'] == state['candidateImageId'] and built['runtimeHashes'] == state['after']
    assert built['baseLayersPreserved'] and built['imageConfigurationPreserved']
    assert docker('image', 'inspect', '--format', '{{.Id}}', IMAGE).decode().strip() == state['candidateImageId']
    configuration_preflight(state)
    script = b"""import {query,closeDb} from './src/db.js';try {
      const row=(await query(`SELECT
        (SELECT count(*) FROM operator_netsuite_posting_commands WHERE status IN ('posting','finalizing')) AS posting,
        (SELECT count(*) FROM regular_stock_delivery_operations WHERE status IN ('queued','running')) AS delivery,
        (SELECT count(*) FROM regular_stock_handoffs WHERE status='executing' AND lease_until>now()) AS pickup,
        (SELECT count(*) FROM sales_special_stock_cases WHERE closure_review->>'status'='applying'
          OR sales_order_operation_status='creating' OR purchase_order_operation_status='creating'
          OR fulfillment_change->>'status'='applying' OR quantity_review->>'status'='applying') AS special
      `)).rows[0];console.log(JSON.stringify(row));}finally{await closeDb();}"""
    active = json.loads(docker('exec', '-i', '-w', '/app', APP, 'node', '--input-type=module', input=script))
    save('predeploy-active-operations.json', active)
    assert all(int(value) == 0 for value in active.values()), 'An order operation is in progress; wait before restarting'
    current(state)
    try:
        with (RELEASE / 'publish.log').open('wb') as log:
            subprocess.run(compose(state, 'compose.release.yml') + ['up', '-d', '--no-build', '--no-deps', '--pull', 'never', 'app'],
                           cwd=ROOT, stdout=log, stderr=subprocess.STDOUT, check=True, timeout=100)
        verify(state)
    except BaseException:
        try:
            current_image = metadata(APP)['imageId']
        except subprocess.CalledProcessError:
            current_image = None
        if current_image not in [None, state['candidateImageId'], state['app']['imageId']]:
            raise RuntimeError('Another deployment replaced the app; do not overwrite it with rollback')
        with (RELEASE / 'rollback.log').open('wb') as log:
            subprocess.run(compose(state, 'compose.rollback.yml') + ['up', '-d', '--no-build', '--no-deps', '--pull', 'never', 'app'],
                           cwd=ROOT, stdout=log, stderr=subprocess.STDOUT, check=True, timeout=100)
        core.ready(state['app']['imageId'])
        save('rollback-result.json', {'previousAppRestored': True})
        raise


def refresh_after_rollback():
    state = manifest()
    assert json.loads((RELEASE / 'rollback-result.json').read_text())['previousAppRestored']
    restored = metadata(APP)
    assert restored['imageId'] == state['app']['imageId']
    assert restored['configuration'] == state['app']['configuration']
    assert resource_policy() == state['resourcePolicy']
    assert [metadata(name) for name in DEPENDENCIES] == state['dependencies']
    for file in FILES:
        assert digest(docker('exec', APP, 'cat', '/app/' + file)) == state['before'][file]
    for name in ['manifest.json', 'publish.log', 'rollback.log', 'rollback-result.json']:
        shutil.copy2(RELEASE / name, RELEASE / ('first-attempt-' + name))
    state['app'] = restored
    save('manifest.json', state)
    current(state)
    configuration_preflight(state)
    print(json.dumps({'rollbackVerified': True, 'candidateUnchanged': True}), flush=True)


if __name__ == '__main__':
    {'prepare': prepare, 'finish-prepare': finish_prepare, 'apply': apply,
     'refresh-after-rollback': refresh_after_rollback, 'verify': lambda: verify(manifest())}[sys.argv[1]]()
