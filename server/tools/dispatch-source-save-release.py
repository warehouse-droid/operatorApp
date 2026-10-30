"""Apply only the reviewed source-refresh/notice patch over the current app image."""
import datetime
import difflib
import hashlib
import importlib.util
import json
import os
import re
from pathlib import Path
import shutil
import subprocess
import sys

SERVER = Path(__file__).resolve().parents[1]
ROOT = SERVER.parent
RELEASE = SERVER / 'deployments/dispatch-source-save-20261022'
BEFORE = RELEASE / 'before-workspace'
APP = 'mbbs-operator-app-app-1'
DEPENDENCIES = ['mbbs-operator-app-db-1', 'mbbs-operator-app-webhook-worker-1', 'mbbs-operator-app-ollama-1']
EXISTING = ['public/dispatch.js', 'public/dispatch.css', 'public/dispatch.html', 'public/mbt-planning.html',
            'src/server.js', 'src/dispatch-executed-order-review-repository.js']
FILES = EXISTING + ['src/dispatch-source-refresh.js']
IMAGE = 'mbbs-operator-app:dispatch-source-save-20261022'
ROLLBACK = 'mbbs-operator-app:rollback-dispatch-source-save-20261022'
spec = importlib.util.spec_from_file_location('release_core', SERVER / 'tools/operator-display-settings-deploy.py')
core = importlib.util.module_from_spec(spec)
spec.loader.exec_module(core)
docker = core.docker


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def save(name, value):
    (RELEASE / name).write_text(json.dumps(value, indent=2) + '\n')


def state():
    return json.loads((RELEASE / 'manifest.json').read_text())


def compose(info, override='compose.release.yml'):
    args = ['sudo', '-n', 'docker', 'compose', '-p', 'mbbs-operator-app']
    for file in info['app']['configFiles'].split(','):
        args.extend(['-f', file])
    return args + ['-f', str(RELEASE / override)]


def current(info):
    assert core.metadata(APP) == info['app'], 'Live app changed; prepare again before release'
    assert [core.metadata(name) for name in DEPENDENCIES] == info['dependencies'], 'Dependency changed'
    assert {file: digest(RELEASE / 'candidate' / file) for file in FILES} == info['files'], 'Candidate changed'


def task_dispatch_source(old, new):
    before, after = old.splitlines(True), new.splitlines(True)
    result = []
    ranges = [(7100, 8500), (11880, 12000), (16960, 16990), (19050, 19120)]
    for tag, start, end, next_start, next_end in difflib.SequenceMatcher(None, before, after, autojunk=False).get_opcodes():
        ours = tag != 'equal' and any(low <= start + 1 <= high for low, high in ranges)
        result.extend(after[next_start:next_end] if ours else before[start:end])
    return ''.join(result)


def prepare():
    os.umask(0o077)
    info = {'app': core.metadata(APP), 'dependencies': [core.metadata(name) for name in DEPENDENCIES],
            'workspace': {file: digest(SERVER / file) for file in FILES}}
    stage = RELEASE / 'candidate'
    if stage.exists():
        shutil.rmtree(stage)
    stage.mkdir()
    subprocess.run(['tar', '--no-same-owner', '-xf', '-', '-C', str(stage)], input=docker('exec', APP, 'tar', '-C', '/app', '-cf', '-',
        'src', 'public', 'package.json', 'package-lock.json'), check=True)
    patch = ''
    for file in EXISTING:
        live = RELEASE / 'live-before' / file
        live.parent.mkdir(parents=True, exist_ok=True)
        live.unlink(missing_ok=True)
        live.write_bytes(docker('exec', APP, 'cat', '/app/' + file))
        old = (BEFORE / file).read_text() if (BEFORE / file).exists() else live.read_text()
        new = (SERVER / file).read_text()
        if file == 'public/dispatch.js':
            new = task_dispatch_source(old, new)
        if file == 'src/server.js':
            old = live.read_text()
            route = 'getDispatchSourceReviewPayload(req.params.id, { baseRevision: req.query.baseRevision })'
            assert old.count(route) == 1, 'Source review route changed; review before release'
            new = old.replace(route, 'getDispatchSourceReviewPayload(req.params.id, { baseRevision: req.query.baseRevision, baseDigest: req.query.baseDigest })')
        if file.endswith('.html'):
            old = live.read_text()
            new = re.sub(r'/dispatch\.js\?v=[^"\s]+', '/dispatch.js?v=20261022-source-save-v1', old)
            new = re.sub(r'/dispatch\.css\?v=[^"\s]+', '/dispatch.css?v=20261022-stable-notices-v1', new)
        task = RELEASE / 'task-source' / file
        task.parent.mkdir(parents=True, exist_ok=True)
        task.write_text(new)
        patch += ''.join(difflib.unified_diff(old.splitlines(True), new.splitlines(True),
                                           fromfile='a/' + file, tofile='b/' + file))
    (RELEASE / 'release.patch').write_text(patch)
    applied = subprocess.run(['patch', '--batch', '--fuzz=0', '-p1', '-d', str(stage)], input=patch, text=True, capture_output=True)
    (RELEASE / 'patch.log').write_text(applied.stdout + applied.stderr)
    assert applied.returncode == 0, 'Release patch did not apply cleanly'
    shutil.copy2(SERVER / FILES[-1], stage / FILES[-1])
    info['files'] = {file: digest(stage / file) for file in FILES}
    # The only server.js change in this task is the source-review query argument.
    server_patch = ''.join(difflib.unified_diff((RELEASE / 'live-before/src/server.js').read_text().splitlines(True),
        (stage / 'src/server.js').read_text().splitlines(True)))
    assert len([line for line in server_patch.splitlines() if line.startswith('+') and not line.startswith('+++')]) == 1
    current(info)
    docker('tag', info['app']['imageId'], ROLLBACK)
    (stage / 'Dockerfile').write_text('FROM ' + ROLLBACK + '\n' + ''.join(
        'COPY --chown=node:node ' + file + ' /app/' + file + '\n' for file in FILES))
    with (RELEASE / 'build.log').open('wb') as output:
        subprocess.run(['sudo', '-n', 'docker', 'build', '--network=none', '--pull=false', '-t', IMAGE, str(stage)],
                       stdout=output, stderr=subprocess.STDOUT, check=True)
    info['imageId'] = docker('image', 'inspect', '--format', '{{.Id}}', IMAGE).decode().strip()
    for name, tag in [('compose.release.yml', IMAGE), ('compose.rollback.yml', ROLLBACK)]:
        (RELEASE / name).write_text('services:\n  app:\n    image: ' + tag + '\n')
    save('manifest.json', info)
    smoke(info)
    print(json.dumps({'prepared': True, 'imageId': info['imageId'], 'files': FILES}), flush=True)


def smoke(info):
    name = 'mbbs-source-release-check-' + str(os.getpid())
    script = "import {readFileSync} from 'node:fs'; import {createHash} from 'node:crypto'; import {dispatchSourceRefreshBaseline} from './src/dispatch-source-refresh.js'; if(typeof dispatchSourceRefreshBaseline!=='function')throw Error('missing helper'); console.log(JSON.stringify(Object.fromEntries(FILES.map(file=>[file,createHash('sha256').update(readFileSync(file)).digest('hex')]))));"
    try:
        output = docker('run', '--rm', '--name', name, '--init', '--network=none', '--cgroup-parent=mbbs-tests.slice',
                        '--memory=512m', '--memory-swap=512m', '--cpus=0.5', '--pids-limit=64', '--read-only',
                        '--tmpfs', '/tmp:rw,size=64m', '--label', 'com.mbbs.lifecycle=disposable-test',
                        '-e', 'NODE_ENV=test', '-e', 'MBBS_ENV_FILE=.env.does-not-exist', '--entrypoint', 'node',
                        IMAGE, '--input-type=module', '-e', script.replace('FILES', json.dumps(FILES)))
        assert json.loads(output) == info['files'], 'Built image hashes differ'
    finally:
        subprocess.run(['sudo', '-n', 'docker', 'rm', '-f', name], capture_output=True)


def verify():
    info = state()
    core.ready(info['imageId'])
    assert core.metadata(APP)['configuration'] == info['app']['configuration'], 'App configuration changed'
    assert [core.metadata(name) for name in DEPENDENCIES] == info['dependencies'], 'Dependency changed'
    rows = docker('exec', APP, 'sha256sum', *['/app/' + file for file in FILES]).decode().splitlines()
    assert {row.split()[1].removeprefix('/app/'): row.split()[0] for row in rows} == info['files']
    script = """import assert from 'node:assert/strict'; import {createHash} from 'node:crypto';
for(const base of ['http://127.0.0.1:3000','https://test.mbbsoperation.com']) {
 const health=await fetch(base+'/health'); assert.equal(health.status,200); assert.equal((await health.json()).ok,true);
 for(const [file,expected] of Object.entries(FILES)) { const response=await fetch(base+'/'+file.replace('public/','')+'?v=source-save-20261022'); assert.equal(response.status,200); assert.equal(createHash('sha256').update(Buffer.from(await response.arrayBuffer())).digest('hex'),expected); }
 assert.equal((await fetch(base+'/api/dispatch/plans/367/executed-order-reviews')).status,401);
} console.log(JSON.stringify({health:200,assets:'verified',anonymousSourceReviews:401}));"""
    http = json.loads(docker('exec', '-i', APP, 'node', '--input-type=module', input=script.replace('FILES', json.dumps(
        {file: value for file, value in info['files'].items() if file.startswith('public/')})).encode()))
    result = {'deployed': True, 'at': datetime.datetime.now(datetime.timezone.utc).isoformat(),
              'imageId': info['imageId'], 'files': info['files'], 'configurationPreserved': True, 'dependenciesUnchanged': True, **http}
    save('deployment-result.json', result)
    print(json.dumps(result), flush=True)


def apply():
    info = state()
    current(info)
    verified = json.loads((RELEASE / 'verified.json').read_text())
    assert verified['passed'] and verified['files'] == info['files'], 'Fresh passing validation required'
    config = json.loads(subprocess.check_output(compose(info) + ['config', '--format', 'json'], cwd=ROOT))['services']['app']
    image = json.loads(docker('image', 'inspect', IMAGE))[0]['Config']
    live = json.loads(docker('inspect', APP))[0]['Config']
    env = dict(entry.split('=', 1) for entry in image['Env'])
    env.update({key: str(value) for key, value in config.get('environment', {}).items()})
    assert env == dict(entry.split('=', 1) for entry in live['Env']), 'Environment drift'
    for field, key in [('Cmd', 'command'), ('Entrypoint', 'entrypoint'), ('User', 'user'), ('WorkingDir', 'working_dir')]:
        assert (image.get(field) if config.get(key) is None else config[key]) == live.get(field), 'Command drift'
    active = docker('exec', DEPENDENCIES[0], 'psql', '-U', 'mbbs_app', '-d', 'mbbs_yard', '-XAt', '-v', 'ON_ERROR_STOP=1', '-c',
        "SELECT (SELECT count(*) FROM operator_netsuite_posting_commands WHERE status IN ('posting','finalizing')) + (SELECT count(*) FROM driver_foreground_action_receipts WHERE status='executing');").decode().strip()
    assert active == '0', 'Active operational writes; retry cutover when idle'
    current(info)
    try:
        with (RELEASE / 'publish.log').open('wb') as output:
            subprocess.run(compose(info) + ['up', '-d', '--no-build', '--no-deps', '--pull', 'never', 'app'],
                           cwd=ROOT, stdout=output, stderr=subprocess.STDOUT, check=True, timeout=60)
        verify()
    except Exception:
        with (RELEASE / 'rollback.log').open('wb') as output:
            subprocess.run(compose(info, 'compose.rollback.yml') + ['up', '-d', '--no-build', '--no-deps', '--pull', 'never', 'app'],
                           cwd=ROOT, stdout=output, stderr=subprocess.STDOUT, check=True, timeout=60)
        core.ready(info['app']['imageId'])
        raise


if __name__ == '__main__':
    {'prepare': prepare, 'apply': apply, 'verify': verify}[sys.argv[1]]()
