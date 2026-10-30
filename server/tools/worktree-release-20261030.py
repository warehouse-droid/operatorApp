"""Prepare, build, deploy and verify the authorized complete application release."""
import datetime
import hashlib
import json
import os
from pathlib import Path
import shlex
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.request

ROOT = Path(__file__).resolve().parents[2]
SERVER = ROOT / 'server'
OUT = SERVER / 'deployments/whole-worktree-20261030'
IMAGE = 'mbbs-operator-app:whole-worktree-20261030'
SERVICES = {'app': 'mbbs-operator-app-app-1', 'webhook-worker': 'mbbs-operator-app-webhook-worker-1'}
DEPENDENCIES = ['mbbs-operator-app-db-1', 'mbbs-operator-app-ollama-1']


def run(*args, **kw):
    return subprocess.run(args, cwd=ROOT, check=True, capture_output=True, **kw).stdout


def inspect(*names):
    return json.loads(run('docker', 'inspect', *names))


def save(name, value, private=False):
    path = OUT / name
    path.write_text(json.dumps(value, indent=2) + '\n')
    path.chmod(0o600 if private else 0o644)


def emit(value):
    print(json.dumps(value), flush=True)


def load(name='manifest.json'):
    return json.loads((OUT / name).read_text())


def inputs():
    names = []
    for line in (SERVER / 'Dockerfile').read_text().splitlines():
        if line.startswith('COPY '): names += shlex.split(line)[1:-1]
    return names


def source_hashes():
    files = []
    for name in inputs():
        path = SERVER / name
        files += list(path.rglob('*')) if path.is_dir() else [path]
    return {str(p.relative_to(SERVER)): hashlib.sha256(p.read_bytes()).hexdigest()
            for p in sorted(files) if p.is_file() and p.suffix not in ['.orig', '.rej', '.pyc']}


def db(query):
    return run('docker', 'exec', '-i', DEPENDENCIES[0], 'sh', '-c',
        'exec psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -X -qAt -v ON_ERROR_STOP=1',
        input=('BEGIN READ ONLY;\n' + query + '\nCOMMIT;').encode()).decode().strip()


def runtime_compose(rows):
    services, volumes, networks = {}, {}, {}
    for name, row in zip(SERVICES, rows):
        config, host = row['Config'], row['HostConfig']
        for key in ['Privileged', 'Devices', 'DeviceRequests', 'CapAdd', 'CapDrop', 'SecurityOpt',
                    'ExtraHosts', 'Dns', 'DnsSearch', 'Links', 'Ulimits', 'CgroupParent']:
            assert not host.get(key), 'Unsupported custom runtime option: ' + name + '/' + key
        service = {'image': row['Image'], 'container_name': SERVICES[name],
            'environment': dict(value.split('=', 1) for value in config['Env']),
            'entrypoint': config['Entrypoint'], 'command': config['Cmd'],
            'user': config['User'], 'working_dir': config['WorkingDir'],
            'restart': host['RestartPolicy']['Name'], 'read_only': host['ReadonlyRootfs'],
            'shm_size': host['ShmSize'], 'volumes': [], 'ports': [], 'networks': {},
            'logging': {'driver': host['LogConfig']['Type'], 'options': host['LogConfig']['Config']},
            'labels': {k: v for k, v in config['Labels'].items() if not k.startswith('com.docker.compose.')}}
        if host.get('NanoCpus'): service['cpus'] = str(host['NanoCpus'] / 1e9)
        for source, target in [('Memory', 'mem_limit'), ('MemorySwap', 'memswap_limit'), ('PidsLimit', 'pids_limit')]:
            if host.get(source): service[target] = host[source]
        if host.get('Init') is not None: service['init'] = host['Init']
        for mount in row['Mounts']:
            assert mount['Type'] in ['bind', 'volume']
            source = mount['Source']
            if mount['Type'] == 'volume':
                source = mount['Name']
                volumes[source] = {'external': True, 'name': mount['Name']}
            service['volumes'].append({'type': mount['Type'], 'source': source,
                'target': mount['Destination'], 'read_only': not mount['RW']})
        for target, bindings in (host.get('PortBindings') or {}).items():
            port, protocol = target.split('/')
            for binding in bindings or []:
                service['ports'].append({'target': int(port), 'published': binding['HostPort'],
                    'host_ip': binding['HostIp'], 'protocol': protocol})
        for network_name, network in row['NetworkSettings']['Networks'].items():
            assert not network.get('IPAMConfig'), 'Static network settings need explicit preservation'
            networks[network_name] = {'external': True, 'name': network_name}
            service['networks'][network_name] = {'aliases': network.get('Aliases') or []}
        if config.get('Healthcheck'):
            check = config['Healthcheck']
            service['healthcheck'] = {'test': check['Test']}
            for key, target in [('Interval', 'interval'), ('Timeout', 'timeout'), ('StartPeriod', 'start_period'), ('StartInterval', 'start_interval')]:
                if check.get(key): service['healthcheck'][target] = str(check[key]) + 'ns'
            if check.get('Retries'): service['healthcheck']['retries'] = check['Retries']
        services[name] = service
    return {'services': services, 'volumes': volumes, 'networks': networks}


def compose(mode):
    return ['docker', 'compose', '-p', 'mbbs-operator-app', '-f', str(OUT / 'compose.runtime.private.json'),
            '-f', str(OUT / ('compose.' + mode + '.json'))]


def prepare():
    assert not (OUT / 'deployment.json').exists(), 'Release already deployed'
    rows = inspect(*SERVICES.values(), *DEPENDENCIES)
    hashes = source_hashes()
    live_lock = run('docker', 'exec', SERVICES['app'], 'sha256sum', '/app/package-lock.json').decode().split()[0]
    assert hashes['package-lock.json'] == live_lock, 'Dependency changes require a clean dependency rebuild'
    applied = json.loads(db("SELECT coalesce(json_agg(filename ORDER BY filename),'[]'::json) FROM schema_migrations;"))
    pending = sorted({p.name for p in (SERVER / 'migrations').glob('*.sql')} - set(applied))
    assert not pending, 'Unexpected unapplied migrations: ' + repr(pending)
    save('containers.before.private.json', rows, True)
    save('compose.runtime.private.json', runtime_compose(rows[:2]), True)
    save('compose.release.json', {'services': {name: {'image': IMAGE} for name in SERVICES}})
    save('compose.rollback.json', {'services': {name: {'image': row['Image']} for name, row in zip(SERVICES, rows)}})
    for name, row in zip(SERVICES, rows):
        run('docker', 'tag', row['Image'], 'mbbs-operator-app:rollback-whole-worktree-20261030-' + name)
    manifest = {'preparedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(),
        'image': IMAGE, 'baseImage': rows[0]['Image'], 'containersBefore': {row['Name']: row['Id'] for row in rows},
        'gitBase': run('git', 'rev-parse', 'HEAD').decode().strip(), 'runtimeHashes': hashes,
        'sourceTreeHash': hashlib.sha256(json.dumps(hashes, sort_keys=True).encode()).hexdigest(),
        'pendingMigrations': pending, 'localMigrationCount': len(list((SERVER / 'migrations').glob('*.sql')))}
    save('manifest.json', manifest)
    run(*compose('release'), 'config', '--quiet')
    emit({'prepared': True, 'runtimeFiles': len(hashes), 'pendingMigrations': pending})


def unchanged():
    manifest = load()
    assert source_hashes() == manifest['runtimeHashes'], 'Worktree source changed after release preparation'
    rows = inspect(*SERVICES.values(), *DEPENDENCIES)
    assert {row['Name']: row['Id'] for row in rows} == manifest['containersBefore'], 'Production changed after preparation'
    return manifest


def build():
    manifest = unchanged()
    with tempfile.TemporaryDirectory(prefix='mbbs-worktree-build-') as temporary:
        stage = Path(temporary)
        for name in manifest['runtimeHashes']:
            path = stage / name
            path.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(SERVER / name, path)
        (stage / 'Dockerfile').write_text('FROM mbbs-operator-app:rollback-whole-worktree-20261030-app\n' +
            ''.join('COPY --chown=node:node ' + name + ' /app/' + name + '\n' for name in inputs()))
        result = subprocess.run(['docker', 'build', '--network', 'none', '--pull=false', '-t', IMAGE, str(stage)],
            cwd=ROOT, capture_output=True, text=True)
        if result.returncode: raise RuntimeError(result.stdout[-4000:] + result.stderr[-4000:])
    manifest['imageId'] = inspect(IMAGE)[0]['Id']
    save('manifest.json', manifest)
    emit({'built': True, 'image': IMAGE, 'imageId': manifest['imageId'], 'runtimeFiles': len(manifest['runtimeHashes'])})


def health():
    with urllib.request.urlopen('http://127.0.0.1:3000/health', timeout=5) as response:
        assert response.status == 200 and json.load(response).get('ok') is True


def ready():
    deadline = time.monotonic() + 90
    while time.monotonic() < deadline:
        try:
            health()
            rows = inspect(*SERVICES.values())
            if all(r['State']['Running'] and r['RestartCount'] == 0 for r in rows): return
        except Exception:
            pass
        time.sleep(2)
    raise RuntimeError('App and worker did not become ready')


def hash_container(name, paths):
    script = "const fs=require('fs'),crypto=require('crypto');process.stdout.write(JSON.stringify(Object.fromEntries(JSON.parse(fs.readFileSync(0,'utf8')).map(p=>[p,crypto.createHash('sha256').update(fs.readFileSync('/app/'+p)).digest('hex')]))));"
    return json.loads(run('docker', 'exec', '-i', name, 'node', '-e', script, input=json.dumps(list(paths)).encode()))


def verify():
    manifest = load()
    before = load('containers.before.private.json')
    after = inspect(*SERVICES.values(), *DEPENDENCIES)
    for index, name in enumerate(SERVICES.values()):
        old, new = before[index], after[index]
        assert new['Image'] == manifest['imageId'] and new['State']['Running'] and new['RestartCount'] == 0
        prior_env, current_env = set(old['Config']['Env']), set(new['Config']['Env'])
        # The current app image adds its browser-cache location to the older
        # worker image's defaults. Preserve every existing setting exactly and
        # permit only this known non-secret image default on the worker.
        allowed_defaults = {'PLAYWRIGHT_BROWSERS_PATH=/ms-playwright'} if index == 1 else set()
        assert prior_env <= current_env and current_env - prior_env <= allowed_defaults, 'Environment drift'
        assert sorted(new['Mounts'], key=lambda m: m['Destination']) == sorted(old['Mounts'], key=lambda m: m['Destination']), 'Mount drift'
        for key in ['Cmd', 'Entrypoint', 'User', 'WorkingDir', 'Healthcheck']:
            assert new['Config'].get(key) == old['Config'].get(key), key
        for key in ['PortBindings', 'NanoCpus', 'Memory', 'MemorySwap', 'PidsLimit', 'RestartPolicy', 'ReadonlyRootfs', 'ShmSize', 'LogConfig', 'Init']:
            assert new['HostConfig'].get(key) == old['HostConfig'].get(key), key
        assert hash_container(name, manifest['runtimeHashes']) == manifest['runtimeHashes'], 'Deployed source mismatch: ' + name
    assert [r['Id'] for r in before[2:]] == [r['Id'] for r in after[2:]], 'Dependency container changed'
    health()
    checked = []
    for path in ['public/operator.html', 'public/control.html', 'public/driver-service-worker.js',
                 'public/special-stock-line-details.js', 'public/special-stock-line-fields.js', 'public/repair/app.js']:
        route = '/' + path.removeprefix('public/')
        with urllib.request.urlopen('http://127.0.0.1:3000' + route, timeout=10) as response:
            assert hashlib.sha256(response.read()).hexdigest() == manifest['runtimeHashes'][path], route
        checked.append(route)
    result = {'healthy': True, 'imageId': manifest['imageId'], 'runtimeFilesPerService': len(manifest['runtimeHashes']),
        'configurationPreserved': True, 'dependenciesUnchanged': True, 'servedAssetHashes': checked,
        'allowedWorkerImageDefault': {'PLAYWRIGHT_BROWSERS_PATH': '/ms-playwright'},
        'at': datetime.datetime.now(datetime.timezone.utc).isoformat()}
    save('verification.json', result)
    emit(result)


def preflight():
    return json.loads(db("""SELECT json_build_object(
      'operatorPostings',(SELECT count(*) FROM operator_netsuite_posting_commands WHERE status IN ('queued','posting','finalizing')),
      'fulfillments',(SELECT count(*) FROM dispatch_sales_order_if_candidates WHERE status='posting'),
      'webhooks',(SELECT count(*) FROM netsuite_order_webhook_inbox WHERE status IN ('processing','running')),
      'driverActions',(SELECT count(*) FROM driver_foreground_action_receipts WHERE status='executing'),
      'openTransactions',(SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND state='idle in transaction'));"""))


def deploy():
    manifest = unchanged()
    checks = json.loads((SERVER / 'test/whole-worktree-deployment-20261030-checks.json').read_text())
    assert checks['passed'], 'Full candidate/baseline check must pass'
    assert checks['candidate']['fileCount'] == 1253, 'Incomplete full-suite result'
    assert checks.get('baseline', {}).get('fileCount', 0) == len(checks['candidate']['failedFiles']), 'Incomplete baseline replay'
    tested = load('tested-source-hashes.json')
    for name, expected in manifest['runtimeHashes'].items():
        if not name.startswith('tools/'):
            assert tested.get(name) == expected, 'Tested source mismatch: ' + name
    smoke = load('smoke.json')
    assert smoke['passed'] and smoke['imageId'] == manifest['imageId'], 'Image rehearsal must pass'
    candidate_smoke = next(s for s in smoke['scenarios'] if s['mode'] == 'candidate')
    assert candidate_smoke.get('workerImageEnvironmentDefaults') == {'PLAYWRIGHT_BROWSERS_PATH': '/ms-playwright'}, 'Worker image default must be rehearsed'
    focused = json.loads((SERVER / 'test/whole-worktree-deployment-20261030-focused.json').read_text())
    assert focused['passed'], 'Focused tests must pass'
    assert all(manifest['runtimeHashes'].get(name) == digest for name, digest in focused['sourceHashes'].items()), 'Focused source mismatch'
    active = preflight()
    save('preflight.json', active)
    assert not any(active.values()), 'Active business work must finish before cutover: ' + repr(active)
    try:
        # Stop the old worker gracefully before replacing the application pair.
        run('docker', 'stop', '--time', '60', SERVICES['webhook-worker'])
        run(*compose('release'), 'up', '-d', '--no-deps', '--no-build', '--pull', 'never', *SERVICES, timeout=180)
        ready()
        verify()
    except BaseException:
        run(*compose('rollback'), 'up', '-d', '--no-deps', '--no-build', '--pull', 'never', *SERVICES, timeout=180)
        ready()
        save('rollback-result.json', {'restoredPriorImages': True, 'at': datetime.datetime.now(datetime.timezone.utc).isoformat()})
        raise
    save('deployment.json', {'deployed': True, 'imageId': manifest['imageId'],
        'at': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'verification': load('verification.json')})


if __name__ == '__main__':
    os.umask(0o077)
    OUT.mkdir(parents=True, exist_ok=True)
    {'prepare': prepare, 'build': build, 'deploy': deploy, 'verify': verify}[sys.argv[1]]()
