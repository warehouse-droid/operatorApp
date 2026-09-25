"""Scoped grouped action release with read-only live verification; no migration or business writes."""
import ast
from contextlib import contextmanager
import datetime
import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys

SERVER = Path(__file__).resolve().parents[1]
VERIFIED = Path('/home/ubuntu/link-to-verified-20260918/server')
spec = importlib.util.spec_from_file_location('release_core', SERVER / 'tools/operator-display-settings-deploy.py')
core = importlib.util.module_from_spec(spec)
spec.loader.exec_module(core)
RELEASE = Path('/home/ubuntu/operatorapp-deploy-backups/group-actions-20260918-v3')
APP = 'mbbs-operator-app-app-1'
WORKER = 'mbbs-operator-app-webhook-worker-1'
DB = 'mbbs-operator-app-db-1'
ADDED = ['src/driver-co-pickup-evidence.js','src/operator-linked-transfer-plan.js','src/dispatch-group-action-repository.js']
catalog = (SERVER / 'tools/link-to-fix-files.mjs').read_text()
FILES = sorted(re.findall(r"'([^']+)'", catalog.split('export const added')[0]))
TESTS = re.findall(r"'([^']+)'", catalog.split('export const tests = ')[1])


@contextmanager
def service(worker=False):
    keys = ['APP', 'RELEASE', 'BEFORE', 'IMAGE', 'ROLLBACK', 'FILES', 'ADDED', 'EXISTING', 'DEPENDENCIES', 'SERVER']
    previous = {key: getattr(core, key) for key in keys}
    role = 'worker' if worker else 'app'
    core.APP = WORKER if worker else APP
    core.SERVER = VERIFIED
    core.RELEASE = RELEASE / role
    core.BEFORE = SERVER / 'test-artifacts/link-to-fix/baseline'
    core.IMAGE = 'mbbs-operator-app:group-actions-' + role + '-20260918-v3'
    core.ROLLBACK = 'mbbs-operator-app:rollback-group-actions-' + role + '-20260918-v3'
    core.FILES = FILES
    core.ADDED = ADDED
    core.EXISTING = sorted(set(FILES) - set(core.ADDED))
    core.DEPENDENCIES = [APP if worker else WORKER, DB, 'mbbs-operator-app-ollama-1']
    original_diff = core.difflib.unified_diff
    def scoped_diff(before, after, **kwargs):
        if worker and kwargs.get('fromfile') == 'a/src/delivery-repository.js':
            # The worker intentionally retains an older outbound-location implementation.
            # Rebase only our new import onto its unique, shared first import.
            added_import = next(line for line in after if 'from "./operator-linked-transfer-plan.js"' in line)
            anchor = 'import { digestDispatchPlan } from "./dispatch-planner-performance.js";\n'
            assert before.count(anchor) == 1 and after.count(anchor) == 1
            unchanged_imports = [line for line in after if line != added_import]
            yield from original_diff(before, unchanged_imports, **kwargs)
            header = before[before.index(anchor):before.index(anchor) + 3]
            yield from original_diff(header, [anchor, added_import, *header[1:]], **kwargs)
        else:
            yield from original_diff(before, after, **kwargs)
    core.difflib.unified_diff = scoped_diff
    try:
        yield
    finally:
        core.difflib.unified_diff = original_diff
        for key, value in previous.items():
            setattr(core, key, value)


def state(worker=False):
    return json.loads((RELEASE / ('worker' if worker else 'app') / 'manifest.json').read_text())


def save(name, data):
    (RELEASE / name).write_text(json.dumps(data, indent=2) + '\n')


def source_gate():
    folder = SERVER / 'test-artifacts/link-to-fix/final-v3'
    for file, expected in json.loads((folder / 'source.json').read_text()).items():
        assert core.digest((VERIFIED / file).read_bytes()) == expected, 'Verified source changed: ' + file
    assert json.loads((folder / 'full-comparison.json').read_text())['unexpected'] == []
    assert all(row['killed'] for row in json.loads((folder / 'mutations.json').read_text()))
    assert all(not row['missing'] for row in json.loads((folder / 'changed-coverage.json').read_text()))
    assert json.loads((folder / 'static.json').read_text())['newDiagnostics'] == []
    assert json.loads((folder / 'secrets.json').read_text()) == []


def prepare_service(worker):
    with service(worker):
        core.prepare()
        candidate = core.RELEASE / 'candidate'
        for name in ['test', 'tools', 'contracts']:
            (candidate / name).symlink_to(SERVER / name, target_is_directory=True)
        for pattern in ['*.js', '*.json', 'Dockerfile*']:
            for path in SERVER.glob(pattern):
                if not (candidate / path.name).exists():
                    shutil.copy2(path, candidate / path.name)


def prepare():
    RELEASE.mkdir(parents=True, exist_ok=False)
    for worker in [False, True]:
        prepare_service(worker)


def build():
    for worker in [False, True]:
        with service(worker):
            core.build()


def check():
    source_gate()
    for worker in [False, True]:
        with service(worker):
            current = core.manifest()
            core.current(current)
            env = {**os.environ, 'DISPLAY_FIX_SOURCE_ROOT': str(core.RELEASE / 'candidate')}
            with (core.RELEASE / 'candidate-focused.log').open('wb') as output:
                subprocess.run(['sudo', '-n', '--preserve-env=DISPLAY_FIX_SOURCE_ROOT', 'bash',
                    'tools/operator-display-test.sh', 'db', 'node', '--test', '--test-concurrency=1', *TESTS],
                    cwd=VERIFIED, env=env, stdout=output, stderr=subprocess.STDOUT, check=True)
            core.current(current)
            core.save('verified.json', {'passed': True, 'imageId': current['candidateImageId'], 'sources': current['after']})
            print(json.dumps({'candidateTestsPassed': True, 'worker': worker}), flush=True)


def live(mode='--preflight'):
    runtime = json.loads(core.docker('inspect', APP))[0]
    environment = RELEASE / 'live-env.private'
    environment.write_text('\n'.join(runtime['Config']['Env']) + '\n')
    environment.chmod(0o600)
    image_id = state()['candidateImageId'] if mode == '--preflight' else runtime['Image']
    try:
        output = core.docker('run', '--rm', '--network', next(iter(runtime['NetworkSettings']['Networks'])),
            '--volumes-from', APP + ':ro', '--env-file', str(environment),
            '-v', str(SERVER / 'tools/link-to-fix-live.mjs') + ':/app/tools/link-to-fix-live.mjs:ro',
            '--entrypoint', 'node', image_id, '/app/tools/link-to-fix-live.mjs', mode).decode()
        result = json.loads(output.strip().splitlines()[-1])
        save('live-' + mode.removeprefix('--') + '.json', result)
        print(json.dumps(result), flush=True)
        return result
    finally:
        environment.unlink()


def database(sql):
    return core.docker('exec', '-i', DB, 'psql', '-U', 'mbbs_app', '-d', 'mbbs_yard',
        '-X', '-v', 'ON_ERROR_STOP=1', '-At', input=sql.encode()).decode()


def compose(rollback=False):
    args = ['sudo', '-n', 'docker', 'compose', '-p', 'mbbs-operator-app']
    for file in state()['app']['configFiles'].split(','):
        args.extend(['-f', file])
    return args + ['-f', str(RELEASE / ('compose.rollback.yml' if rollback else 'compose.release.yml'))]


def verify():
    with service():
        core.ready(state()['candidateImageId'])
    for worker in [False, True]:
        current = state(worker)
        name = WORKER if worker else APP
        runtime = json.loads(core.docker('inspect', name))[0]
        assert runtime['Image'] == current['candidateImageId'] and runtime['State']['Running'] and runtime['RestartCount'] == 0
        assert core.metadata(name)['configuration'] == current['app']['configuration']
        actual = core.docker('exec', name, 'sha256sum', *['/app/' + file for file in FILES]).decode().splitlines()
        assert {line.split()[1].removeprefix('/app/'): line.split()[0] for line in actual} == current['after']
    for before in state()['dependencies'][1:]:
        assert core.metadata(before['id']) == before
    probe = """import assert from 'node:assert/strict';
for(const base of ['http://127.0.0.1:3000','https://test.mbbsoperation.com']) {
  const response=await fetch(base+'/health'); assert.equal(response.status,200); assert.equal((await response.json()).ok,true);
  assert.equal((await fetch(base+'/api/delivery/orders?locationId=1')).status,401);
  const page=await (await fetch(base+'/dispatch.html')).text();
  assert.ok(page.includes('dispatch.css?v=20260918-linked-to-v1'));
  assert.ok(page.includes('dispatch.js?v=20260918-group-actions-v1'));
}
console.log(JSON.stringify({health:200,anonymousDelivery:401}));"""
    http = json.loads(core.docker('exec', '-i', APP, 'node', '--input-type=module', input=probe.encode()))
    confirmed = live('--verify')
    result = {'deployed': True, 'at': datetime.datetime.now(datetime.timezone.utc).isoformat(),
        'appImageId': state()['candidateImageId'], 'workerImageId': state(True)['candidateImageId'],
        'configurationPreserved': True, 'databaseAndOllamaUnchanged': True, 'migration': None,
        'verified': confirmed, **http}
    save('deployment-result.json', result)
    print(json.dumps(result), flush=True)


def apply():
    source_gate()
    assert json.loads((RELEASE / 'live-preflight.json').read_text())['passed']
    for worker in [False, True]:
        with service(worker):
            current = core.manifest()
            core.current(current)
            assert json.loads((core.RELEASE / 'verified.json').read_text()) == {
                'passed': True, 'imageId': current['candidateImageId'], 'sources': current['after']}
    for rollback in [False, True]:
        lines = ['services:']
        for worker in [False, True]:
            current = state(worker)
            lines.extend(['  ' + ('webhook-worker' if worker else 'app') + ':',
                          '    image: ' + (current['app']['imageId'] if rollback else current['candidateImageId'])])
        (RELEASE / ('compose.rollback.yml' if rollback else 'compose.release.yml')).write_text('\n'.join(lines) + '\n')
    resolved = json.loads(subprocess.check_output(compose() + ['config', '--format', 'json'], cwd=SERVER.parent))['services']
    for worker in [False, True]:
        name = WORKER if worker else APP
        settings = resolved['webhook-worker' if worker else 'app']
        image = json.loads(core.docker('image', 'inspect', state(worker)['candidateImageId']))[0]['Config']
        runtime = json.loads(core.docker('inspect', name))[0]['Config']
        expected = dict(entry.split('=', 1) for entry in image['Env'])
        expected.update({key: str(value) for key, value in settings.get('environment', {}).items()})
        assert expected == dict(entry.split('=', 1) for entry in runtime['Env'])
        for field, option in [('Cmd', 'command'), ('Entrypoint', 'entrypoint'), ('User', 'user'), ('WorkingDir', 'working_dir')]:
            assert (image.get(field) if settings.get(option) is None else settings[option]) == runtime.get(field)
    command = ['up', '-d', '--no-build', '--no-deps', '--pull', 'never', 'app', 'webhook-worker']
    try:
        with (RELEASE / 'cutover.log').open('wb') as output:
            subprocess.run(compose() + command, cwd=SERVER.parent, stdout=output, stderr=subprocess.STDOUT, check=True, timeout=100)
        verify()
    except Exception:
        with (RELEASE / 'rollback.log').open('wb') as output:
            subprocess.run(compose(True) + command, cwd=SERVER.parent, stdout=output, stderr=subprocess.STDOUT, check=True, timeout=100)
        save('rollback.json', {'imagesRestored': True, 'databaseMigration': False})
        raise


if __name__ == '__main__':
    os.umask(0o077)
    ast.parse(Path(__file__).read_text())
    {'prepare': prepare, 'build': build, 'check': check, 'preflight': live, 'apply': apply, 'verify': verify}[sys.argv[1]]()
