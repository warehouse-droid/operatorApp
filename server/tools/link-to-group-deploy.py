"""Deploy only the Link TO changes over each running service, with automatic rollback."""
from contextlib import contextmanager
import datetime
import importlib.util
import json
import os
from pathlib import Path
import re
import subprocess
import sys

SERVER = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('scoped_release', SERVER / 'tools/link-to-fix-deploy.py')
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)
core = release.core
ARTIFACT = SERVER / 'test-artifacts/link-to-group'
RELEASE = ARTIFACT / 'deployment-20260923'
FILES = sorted(row['file'] for row in json.loads((SERVER / 'test/support/link-to-group-changes.json').read_text()))
VERSION = '20260923-link-to-group'
APP, WORKER = release.APP, release.WORKER
docker = core.docker


def capture_docker(*args, **kwargs):
    result = docker(*args, **kwargs)
    if args[0] == 'cp' and Path(args[-1]).is_relative_to(RELEASE):
        # Docker copies the restrictive source ownership as root; the release
        # stays readable only by the user preparing it.
        subprocess.run(['sudo', '-n', 'chown', '-R', f'{os.getuid()}:{os.getgid()}', args[-1]], check=True)
    return result


core.docker = capture_docker


@contextmanager
def service(worker=False):
    keys = ['APP', 'RELEASE', 'BEFORE', 'IMAGE', 'ROLLBACK', 'FILES', 'ADDED', 'EXISTING', 'DEPENDENCIES', 'SERVER']
    previous = {key: getattr(core, key) for key in keys}
    role = 'worker' if worker else 'app'
    core.APP = WORKER if worker else APP
    core.RELEASE = RELEASE / role
    core.SERVER = SERVER
    core.BEFORE = Path(os.environ.get('LINK_TO_GROUP_BASELINE', '/tmp/link-to-group-baseline'))
    core.IMAGE = 'mbbs-operator-app:link-to-group-' + role + '-20260923-v1'
    core.ROLLBACK = 'mbbs-operator-app:rollback-link-to-group-' + role + '-20260923-v1'
    core.FILES = FILES
    core.ADDED = []
    core.EXISTING = FILES
    core.DEPENDENCIES = [APP if worker else WORKER, release.DB, 'mbbs-operator-app-ollama-1']
    original_diff = core.difflib.unified_diff

    def scoped_diff(before, after, **kwargs):
        if kwargs.get('fromfile') == 'a/public/dispatch.html':
            # Preserve all independently deployed shell changes and asset versions.
            old = (core.RELEASE / 'baseline/public/dispatch.html').read_text()
            new, count = re.subn(r'/dispatch\.js\?v=[^"\s]+', '/dispatch.js?v=' + VERSION, old)
            assert count == 1, 'Unexpected Dispatch script reference'
            before, after = old.splitlines(True), new.splitlines(True)
        yield from original_diff(before, after, **kwargs)

    core.difflib.unified_diff = scoped_diff
    try:
        yield
    finally:
        core.difflib.unified_diff = original_diff
        for key, value in previous.items():
            setattr(core, key, value)


def source_gate():
    source = json.loads((ARTIFACT / 'source.json').read_text())
    for file, expected in source['files'].items():
        assert core.digest((SERVER / file).read_bytes()) == expected, 'Verified source changed: ' + file
    assert json.loads((ARTIFACT / 'full-comparison.json').read_text())['unexpected'] == []
    assert all(row['killed'] for row in json.loads((ARTIFACT / 'mutations.json').read_text()))
    assert all(not row['missing'] for row in json.loads((ARTIFACT / 'changed-coverage.json').read_text()))
    assert json.loads((ARTIFACT / 'static.json').read_text())['findings'] == []


def check():
    for worker in [False, True]:
        with service(worker):
            current = core.manifest()
            core.current(current)
            env = {**os.environ, 'LINK_TO_GROUP_SOURCE_ROOT': str(core.RELEASE / 'candidate')}
            with (core.RELEASE / 'candidate-focused.log').open('wb') as output:
                subprocess.run(['sudo', '-n', '--preserve-env=LINK_TO_GROUP_SOURCE_ROOT', 'bash',
                    'tools/link-to-group-test.sh', 'node', 'tools/link-to-group-checks.mjs', 'shuffle'],
                    cwd=SERVER, env=env, stdout=output, stderr=subprocess.STDOUT, check=True)
            core.current(current)
            core.save('verified.json', {'passed': True, 'imageId': current['candidateImageId'], 'sources': current['after']})
            print(json.dumps({'candidateTestsPassed': True, 'worker': worker}), flush=True)


def live(mode='--preflight'):
    runtime = json.loads(core.docker('inspect', APP))[0]
    environment = RELEASE / 'live-env.private'
    environment.write_text('\n'.join(runtime['Config']['Env']) + '\n')
    environment.chmod(0o600)
    image_id = release.state()['candidateImageId'] if mode == '--preflight' else runtime['Image']
    try:
        output = core.docker('run', '--rm', '--network', next(iter(runtime['NetworkSettings']['Networks'])),
            '--volumes-from', APP + ':ro', '--env-file', str(environment),
            '-v', str(SERVER / 'tools/link-to-group-live.mjs') + ':/app/tools/link-to-group-live.mjs:ro',
            '--entrypoint', 'node', image_id, '/app/tools/link-to-group-live.mjs').decode()
        result = json.loads(output.strip().splitlines()[-1])
        release.save('live-' + mode.removeprefix('--') + '.json', result)
        print(json.dumps(result), flush=True)
        return result
    finally:
        environment.unlink()


def verify():
    with service():
        core.ready(release.state()['candidateImageId'])
    for worker in [False, True]:
        current = release.state(worker)
        name = WORKER if worker else APP
        runtime = json.loads(core.docker('inspect', name))[0]
        assert runtime['Image'] == current['candidateImageId'] and runtime['State']['Running'] and runtime['RestartCount'] == 0
        assert core.metadata(name)['configuration'] == current['app']['configuration']
        actual = core.docker('exec', name, 'sha256sum', *['/app/' + file for file in FILES]).decode().splitlines()
        assert {line.split()[1].removeprefix('/app/'): line.split()[0] for line in actual} == current['after']
    for before in release.state()['dependencies'][1:]:
        assert core.metadata(before['id']) == before
    hashes = {file: value for file, value in release.state()['after'].items() if file.startswith('public/')}
    probe = """import assert from 'node:assert/strict'; import crypto from 'node:crypto';
for (const base of ['http://127.0.0.1:3000','https://test.mbbsoperation.com']) {
  const health=await fetch(base+'/health'); assert.equal(health.status,200); assert.equal((await health.json()).ok,true);
  assert.equal((await fetch(base+'/api/delivery/orders?locationId=1')).status,401);
  for (const [file, expected] of Object.entries(HASHES)) {
    const response=await fetch(base+'/'+file.replace(/^public\\//,''), {headers:{'Cache-Control':'no-cache'}});
    assert.equal(response.status,200,file);
    assert.equal(crypto.createHash('sha256').update(Buffer.from(await response.arrayBuffer())).digest('hex'),expected,file);
  }
}
console.log(JSON.stringify({localHealth:200,publicHealth:200,anonymousDelivery:401,publicAssetHashesVerified:true}));
""".replace('HASHES', json.dumps(hashes))
    http = json.loads(core.docker('exec', '-i', APP, 'node', '--input-type=module', input=probe.encode()))
    confirmed = live('--verify')
    result = {'deployed': True, 'at': datetime.datetime.now(datetime.timezone.utc).isoformat(),
        'appImageId': release.state()['candidateImageId'], 'workerImageId': release.state(True)['candidateImageId'],
        'configurationPreserved': True, 'databaseAndOllamaUnchanged': True, 'migration': None,
        'verified': confirmed, **http}
    release.save('deployment-result.json', result)
    print(json.dumps(result), flush=True)


release.SERVER = SERVER
release.VERIFIED = SERVER
release.RELEASE = RELEASE
release.FILES = FILES
release.ADDED = []
release.service = service
release.source_gate = source_gate
release.live = live
release.verify = verify

if __name__ == '__main__':
    os.umask(0o077)
    {'prepare': release.prepare, 'build': release.build, 'check': check, 'preflight': live,
     'apply': release.apply, 'verify': verify}[sys.argv[1]]()
