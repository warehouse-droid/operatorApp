"""Apply only the verified SCM search/recovery patch over the current live image."""
import datetime
import difflib
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import time
import urllib.request

ROOT = Path(__file__).resolve().parents[2]
SERVER = ROOT / 'server'
RELEASE = SERVER / 'deployments/scm-po-search-20261029'
FILES = ['src/scm-purchase-order-catalog-repository.js', 'src/dispatch-repository.js', 'src/server.js']
APP = 'mbbs-operator-app-app-1'
DEPENDENCIES = ['mbbs-operator-app-db-1', 'mbbs-operator-app-webhook-worker-1', 'mbbs-operator-app-ollama-1']
IMAGE = 'mbbs-operator-app:scm-po-search-20261029'


def run(*args):
    return subprocess.check_output(args, cwd=ROOT, stderr=subprocess.PIPE)


def inspect(*names):
    return json.loads(run('docker', 'inspect', *names))


def digest(value):
    return hashlib.sha256(value).hexdigest()


def save(name, value):
    (RELEASE / name).write_text(json.dumps(value, indent=2) + '\n')


def compose(before, override):
    labels = before['Config']['Labels']
    command = ['docker', 'compose', '--project-name', labels['com.docker.compose.project'],
               '--env-file', str(ROOT / 'docker/env/.env')]
    command += ['-f', str(RELEASE / 'compose.runtime.private.json')]
    return command + ['-f', str(RELEASE / override)]


def runtime_compose(before, rollback_image):
    config, host = before['Config'], before['HostConfig']
    # This host uses a standard application container. Refuse to silently drop
    # any custom privilege/device/runtime option when capturing its configuration.
    for key in ['Privileged', 'Devices', 'DeviceRequests', 'CapAdd', 'CapDrop', 'SecurityOpt', 'ExtraHosts',
                'Dns', 'DnsSearch', 'Links', 'Ulimits', 'CgroupParent', 'Memory', 'NanoCpus', 'PidsLimit']:
        assert not host.get(key), 'Unsupported nondefault runtime setting: ' + key
    service = {'image': rollback_image, 'container_name': APP,
               'environment': dict(value.split('=', 1) for value in config['Env']),
               'entrypoint': config['Entrypoint'], 'command': config['Cmd'],
               'user': config['User'], 'working_dir': config['WorkingDir'],
               'restart': host['RestartPolicy']['Name'], 'read_only': host['ReadonlyRootfs'],
               'shm_size': host['ShmSize'], 'volumes': [], 'ports': [], 'networks': {},
               'logging': {'driver': host['LogConfig']['Type'], 'options': host['LogConfig']['Config']},
               'labels': {k: v for k, v in config['Labels'].items() if not k.startswith('com.docker.compose.')}}
    volumes, networks = {}, {}
    for index, mount in enumerate(before['Mounts']):
        assert mount['Type'] in ['bind', 'volume'], 'Unsupported mount type'
        source = mount['Source']
        if mount['Type'] == 'volume':
            source = 'live_volume_' + str(index)
            volumes[source] = {'external': True, 'name': mount['Name']}
        service['volumes'].append({'type': mount['Type'], 'source': source,
                                   'target': mount['Destination'], 'read_only': not mount['RW']})
    for target, bindings in host['PortBindings'].items():
        port, protocol = target.split('/')
        for binding in bindings:
            service['ports'].append({'target': int(port), 'published': binding['HostPort'],
                                     'host_ip': binding['HostIp'], 'protocol': protocol})
    for index, (name, network) in enumerate(before['NetworkSettings']['Networks'].items()):
        key = 'live_network_' + str(index)
        assert not network.get('IPAMConfig'), 'Static network configuration requires preservation'
        networks[key] = {'external': True, 'name': name}
        service['networks'][key] = {'aliases': network.get('Aliases') or []}
    if config.get('Healthcheck'):
        check = config['Healthcheck']
        service['healthcheck'] = {'test': check['Test']}
        for original, key in [('Interval', 'interval'), ('Timeout', 'timeout'), ('StartPeriod', 'start_period'), ('StartInterval', 'start_interval')]:
            if check.get(original): service['healthcheck'][key] = str(check[original]) + 'ns'
        if check.get('Retries'): service['healthcheck']['retries'] = check['Retries']
    if host.get('Init') is not None: service['init'] = host['Init']
    return {'services': {'app': service}, 'volumes': volumes, 'networks': networks}


def prepare():
    before = inspect(APP, *DEPENDENCIES)
    save('containers.before.private.json', before)
    stage = RELEASE / 'image'
    stage.mkdir(exist_ok=True)
    patch = ''
    for name in FILES:
        live = run('docker', 'exec', APP, 'cat', '/app/' + name)
        target = stage / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(live)
        original = RELEASE / 'live-before' / name
        original.parent.mkdir(parents=True, exist_ok=True)
        original.write_bytes(live)
        patch += ''.join(difflib.unified_diff(
            (RELEASE / 'workspace-before' / name).read_text().splitlines(True),
            (SERVER / name).read_text().splitlines(True), fromfile='a/' + name, tofile='b/' + name))
    (RELEASE / 'release.patch').write_text(patch)
    subprocess.run(['patch', '--batch', '--forward', '--fuzz=0', '-p1', '-d', str(stage)],
                   input=patch, text=True, check=True, stdout=subprocess.DEVNULL)
    rollback_image = 'mbbs-operator-app:pre-scm-po-search-' + before[0]['Image'].split(':')[1][:12]
    run('docker', 'tag', before[0]['Image'], rollback_image)
    (stage / 'Dockerfile').write_text('FROM ' + rollback_image + '\n' + ''.join(
        'COPY --chown=node:node ' + name + ' /app/' + name + '\n' for name in FILES))
    save('compose.release.json', {'services': {'app': {'image': IMAGE}}})
    save('compose.rollback.json', {'services': {'app': {'image': rollback_image}}})
    save('compose.runtime.private.json', runtime_compose(before[0], rollback_image))
    with (RELEASE / 'build.log').open('wb') as output:
        subprocess.run(['docker', 'build', '--network', 'none', '--pull=false', '-t', IMAGE, str(stage)],
                       stdout=output, stderr=subprocess.STDOUT, check=True)
    configured = json.loads(run(*compose(before[0], 'compose.release.json'), 'config', '--format', 'json'))
    actual_env = dict(value.split('=', 1) for value in before[0]['Config']['Env'])
    image_env = dict(value.split('=', 1) for value in inspect(IMAGE)[0]['Config']['Env'])
    candidate_env = {**image_env, **{key: str(value) for key, value in configured['services']['app']['environment'].items()}}
    assert candidate_env == actual_env, 'Unexpected runtime environment change'
    manifest = {'baseImage': before[0]['Image'], 'baseContainer': before[0]['Id'],
                'image': IMAGE, 'imageId': inspect(IMAGE)[0]['Id'],
                'workspaceHashes': {name: digest((SERVER / name).read_bytes()) for name in FILES},
                'candidateHashes': {name: digest((stage / name).read_bytes()) for name in FILES}}
    save('manifest.json', manifest)
    print(json.dumps({'prepared': IMAGE, 'baseImage': manifest['baseImage'], 'files': FILES}))


def health():
    with urllib.request.urlopen('http://127.0.0.1:3000/health', timeout=3) as response:
        return response.status == 200 and json.load(response).get('ok') is True


def wait_ready():
    deadline = time.monotonic() + 60
    while time.monotonic() < deadline:
        try:
            if health():
                return
        except (OSError, ValueError):
            pass
        time.sleep(1)
    raise RuntimeError('Application health did not recover within 60 seconds')


def verify():
    manifest = json.loads((RELEASE / 'manifest.json').read_text())
    before = json.loads((RELEASE / 'containers.before.private.json').read_text())
    after = inspect(APP, *DEPENDENCIES)
    assert after[0]['Image'] == manifest['imageId'] and after[0]['State']['Running']
    assert sorted(after[0]['Config']['Env']) == sorted(before[0]['Config']['Env'])
    assert sorted(after[0]['Mounts'], key=lambda row: row['Destination']) == sorted(before[0]['Mounts'], key=lambda row: row['Destination'])
    for key in ['Cmd', 'Entrypoint', 'User', 'WorkingDir', 'Healthcheck']:
        assert after[0]['Config'].get(key) == before[0]['Config'].get(key), key
    assert after[0]['HostConfig']['PortBindings'] == before[0]['HostConfig']['PortBindings']
    for name, expected in manifest['candidateHashes'].items():
        assert digest(run('docker', 'exec', APP, 'cat', '/app/' + name)) == expected, name
    assert [row['Id'] for row in after[1:]] == [row['Id'] for row in before[1:]]
    assert health()
    result = {'healthy': True, 'image': manifest['imageId'], 'files': FILES,
              'dependenciesUnchanged': True, 'at': datetime.datetime.now(datetime.timezone.utc).isoformat()}
    save('verification.json', result)
    print(json.dumps(result))


def apply():
    manifest = json.loads((RELEASE / 'manifest.json').read_text())
    before = json.loads((RELEASE / 'containers.before.private.json').read_text())
    checks = json.loads((RELEASE / 'checks.json').read_text())
    assert checks['passed'] and checks['sourceRestored'], 'Verification must pass before release'
    for report_name in ['read-only-check.json', 'extended-read-check.json']:
        reads = json.loads((RELEASE / report_name).read_text())
        assert reads['passed'], 'Live correctness and performance checks must pass before release'
        for name, expected in reads['hashes'].items():
            assert manifest['workspaceHashes']['src/' + name] == expected, 'Read benchmark source changed'
    assert checks['hashes'] == manifest['workspaceHashes'], 'Release source differs from the verified source'
    assert inspect(APP)[0]['Id'] == manifest['baseContainer'], 'Live release changed; prepare again'
    try:
        with (RELEASE / 'cutover.log').open('wb') as output:
            subprocess.run(compose(before[0], 'compose.release.json') + ['up', '-d', '--no-deps', '--no-build', '--pull', 'never', 'app'],
                           cwd=ROOT, stdout=output, stderr=subprocess.STDOUT, check=True, timeout=90)
        wait_ready()
        verify()
    except Exception:
        with (RELEASE / 'rollback.log').open('wb') as output:
            subprocess.run(compose(before[0], 'compose.rollback.json') + ['up', '-d', '--no-deps', '--no-build', '--pull', 'never', 'app'],
                           cwd=ROOT, stdout=output, stderr=subprocess.STDOUT, check=True, timeout=90)
        wait_ready()
        raise


if __name__ == '__main__':
    os.umask(0o077)
    RELEASE.mkdir(exist_ok=True)
    {'prepare': prepare, 'apply': apply, 'verify': verify}[sys.argv[1]]()
