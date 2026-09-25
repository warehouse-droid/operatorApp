"""Prepare a scoped child-location release, validate SOB120598, then cut over."""
import datetime
import importlib.util
import json
import os
from pathlib import Path
import re
import subprocess
import sys

SERVER = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('release_core', SERVER / 'tools/operator-display-settings-deploy.py')
core = importlib.util.module_from_spec(spec)
spec.loader.exec_module(core)
core.RELEASE = Path('/home/ubuntu/operatorapp-deploy-backups/child-location-20260918-v1')
core.BEFORE = Path('/tmp/operator-child-locations-before')
core.IMAGE = 'mbbs-operator-app:child-location-20260918-v1'
core.ROLLBACK = 'mbbs-operator-app:rollback-child-location-20260918-v1'
core.MIGRATION = '208_child_location_fulfillment.sql'
catalog = (SERVER / 'tools/child-location-files.mjs').read_text()
core.EXISTING = json.loads(re.search(r'export const existing = (\[.*?\]);', catalog, re.S)[1])
core.ADDED = json.loads(re.search(r'export const added = (\[.*?\]);', catalog, re.S)[1])
core.FILES = sorted(core.EXISTING + core.ADDED)


def shell_assets(file, text):
    version = '20260918-child-location-v1'
    text, count = re.subn(r'/operator\.js\?v=[^"\s]+', '/operator.js?v=' + version, text)
    assert count == 1
    if file.endswith('service-worker.js'):
        text, count = re.subn(r'const CACHE_NAME = "[^"]+";', 'const CACHE_NAME = "mbbs-yard-operator-' + version + '";', text)
        assert count == 1
    return text


core.shell_assets = shell_assets


def regression_gate():
    state = core.manifest()
    verified = json.loads((core.RELEASE / 'verified.json').read_text())
    assert verified['imageId'] == state['candidateImageId'] and verified['passed']
    assert verified['sources'] == state['after']
    core.current(state)
    return state


def active():
    return core.database("SELECT (SELECT count(*) FROM operator_netsuite_posting_commands WHERE status IN ('posting','finalizing')) + (SELECT count(*) FROM dispatch_sales_order_if_candidates WHERE status='posting');").strip()


def migrate():
    regression_gate()
    if core.database("SELECT count(*) FROM schema_migrations WHERE filename='" + core.MIGRATION + "';").strip() == '1':
        return
    for filename, options in [('schema-before.dump', ['--schema-only']), ('migrations-before.dump', ['--table=public.schema_migrations'])]:
        target = core.RELEASE / filename
        assert not target.exists(), 'Migration backup already exists; inspect before retrying'
        with target.open('wb') as output:
            subprocess.run(['sudo', '-n', 'docker', 'exec', core.DEPENDENCIES[1], 'pg_dump', '-U', 'mbbs_app', '-d', 'mbbs_yard', '--format=custom', *options], stdout=output, check=True)
        with target.open('rb') as source:
            toc = core.docker('exec', '-i', core.DEPENDENCIES[1], 'pg_restore', '--list', stdin=source)
        assert b'schema_migrations' in toc
        target.with_suffix(target.suffix + '.toc').write_bytes(toc)
    assert active() == '0', 'A fulfillment is actively posting'
    sql = (core.RELEASE / 'candidate/migrations' / core.MIGRATION).read_text()
    result = core.database("BEGIN; SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='30s';\n" + sql + "\nINSERT INTO schema_migrations(filename) VALUES ('" + core.MIGRATION + "'); COMMIT;")
    (core.RELEASE / 'migration.log').write_text(result)
    print(json.dumps({'migrationApplied': core.MIGRATION, 'applicationNotReplaced': True}))


def live(read_only=False):
    state = core.manifest() if read_only else regression_gate()
    core.current(state)
    if not read_only:
        assert core.database("SELECT count(*) FROM schema_migrations WHERE filename='" + core.MIGRATION + "';").strip() == '1'
    runtime = json.loads(core.docker('inspect', core.APP))[0]
    environment = core.RELEASE / 'live-env.private'
    environment.write_text('\n'.join(runtime['Config']['Env']) + '\n')
    environment.chmod(0o600)
    evidence = core.RELEASE / 'live'
    evidence.mkdir(exist_ok=True)
    evidence.chmod(0o700)
    network = next(iter(runtime['NetworkSettings']['Networks']))
    command = ['sudo', '-n', 'docker', 'run', '--rm', '--network', network, '--volumes-from', core.APP + ':ro',
               '--env-file', str(environment), '-v', str(evidence) + ':/evidence', '-v', str(SERVER / 'tools/child-location-live.mjs') + ':/app/child-location-live.mjs:ro',
               '-v', str(core.RELEASE / 'manifest.json') + ':/release-manifest.json:ro',
               '--entrypoint', 'node', state['candidateImageId'], 'child-location-live.mjs']
    if read_only:
        command.append('--read-only')
    try:
        subprocess.run(command, check=True)
    finally:
        environment.unlink()


def verify():
    state = core.manifest()
    core.ready(state['candidateImageId'])
    after = core.metadata(core.APP)
    assert after['configuration'] == state['app']['configuration']
    assert [core.metadata(name) for name in core.DEPENDENCIES] == state['dependencies']
    actual = core.docker('exec', core.APP, 'sha256sum', *['/app/' + file for file in core.FILES]).decode().splitlines()
    assert {line.split()[1].removeprefix('/app/'): line.split()[0] for line in actual} == state['after']
    assets = {file: value for file, value in state['after'].items() if file.startswith('public/')}
    script = """import assert from 'node:assert/strict'; import crypto from 'node:crypto';
for (const base of ['http://127.0.0.1:3000','https://test.mbbsoperation.com']) {
  for (const [file, expected] of Object.entries(ASSETS)) {
    const response=await fetch(base+'/'+file.replace(/^public\\//,''), {headers:{'Cache-Control':'no-cache'}});
    assert.equal(response.status,200,file); assert.equal(crypto.createHash('sha256').update(Buffer.from(await response.arrayBuffer())).digest('hex'),expected,file);
  }
  const health=await fetch(base+'/health'); assert.equal(health.status,200); assert.equal((await health.json()).ok,true);
  assert.equal((await fetch(base+'/api/delivery/orders?locationId=1')).status,401);
}
console.log(JSON.stringify({health:200,anonymousDelivery:401,assetsVerified:true}));
""".replace('ASSETS', json.dumps(assets))
    http = json.loads(core.docker('exec', '-i', core.APP, 'node', '--input-type=module', input=script.encode()))
    result = {'deployed': True, 'imageId': after['imageId'], 'at': datetime.datetime.now(datetime.timezone.utc).isoformat(),
              'configurationPreserved': True, 'dependenciesUnchanged': True, **http}
    core.save('deployment-result.json', result)
    print(json.dumps(result))


def apply():
    state = regression_gate()
    live_result = json.loads((core.RELEASE / 'live/result.json').read_text())
    assert live_result['passed'] and live_result['sourceOrderId'] == 996102 and live_result['inventoryLocationId'] == 14
    assert live_result['sourceHashes'] == {name: state['after'][name] for name in live_result['sourceHashes']}
    resolved = json.loads(subprocess.check_output(core.compose(state, 'compose.release.yml') + ['config', '--format', 'json'], cwd=core.ROOT))['services']['app']
    image = json.loads(core.docker('image', 'inspect', state['candidateImageId']))[0]['Config']
    runtime = json.loads(core.docker('inspect', core.APP))[0]['Config']
    expected = dict(entry.split('=', 1) for entry in image['Env'])
    expected.update({key: str(value) for key, value in resolved.get('environment', {}).items()})
    assert expected == dict(entry.split('=', 1) for entry in runtime['Env']), 'Compose would change the environment'
    for field, option in [('Cmd','command'),('Entrypoint','entrypoint'),('User','user'),('WorkingDir','working_dir')]:
        assert (image.get(field) if resolved.get(option) is None else resolved[option]) == runtime.get(field)
    assert active() == '0', 'A fulfillment is actively posting'
    command = ['up', '-d', '--no-build', '--no-deps', '--pull', 'never', 'app']
    try:
        with (core.RELEASE / 'cutover.log').open('wb') as output:
            subprocess.run(core.compose(state, 'compose.release.yml') + command, cwd=core.ROOT, stdout=output, stderr=subprocess.STDOUT, check=True, timeout=100)
        verify()
    except Exception:
        with (core.RELEASE / 'rollback.log').open('wb') as output:
            subprocess.run(core.compose(state, 'compose.rollback.yml') + command, cwd=core.ROOT, stdout=output, stderr=subprocess.STDOUT, check=True, timeout=100)
        core.ready(state['app']['imageId'])
        core.save('rolled-back.json', {'migrationAndRealFulfillmentRetained': True})
        raise


if __name__ == '__main__':
    os.umask(0o077)
    {'prepare': core.prepare, 'build': core.build, 'migrate': migrate, 'preflight': lambda: live(True), 'live': live, 'apply': apply, 'verify': verify}[sys.argv[1]]()
