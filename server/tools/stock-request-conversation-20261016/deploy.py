"""Deploy only conversation changes over the captured live source, retaining configuration and rollback."""
import difflib
import datetime
import hashlib
import importlib.util
import json
from pathlib import Path
import shutil
import subprocess
import sys

TASK = Path(__file__).resolve().parent
SERVER = TASK.parents[1]
ROOT = SERVER.parent
OUT = SERVER / 'test-artifacts/stock-request-conversation-20261016'
RELEASE = SERVER / 'deployments/stock-request-conversation-20261016'
APP = 'mbbs-operator-app-app-1'
DEPENDENCIES = ['mbbs-operator-app-db-1', 'mbbs-operator-app-webhook-worker-1', 'mbbs-operator-app-ollama-1']
IMAGE = 'mbbs-operator-app:stock-request-conversation-20261016'
FILES = json.loads((TASK / 'files.json').read_text())
spec = importlib.util.spec_from_file_location('closure_release_core', SERVER / 'tools/operator-display-settings-deploy.py')
core = importlib.util.module_from_spec(spec)
spec.loader.exec_module(core)
docker, metadata = core.docker, core.metadata


def digest(value):
    return hashlib.sha256(value).hexdigest()


def save(name, data):
    (RELEASE / name).write_text(json.dumps(data, indent=2) + '\n')


def compose(state, filename):
    args = ['sudo', '-n', 'docker', 'compose', '-p', 'mbbs-operator-app']
    for config in state['app']['configFiles'].split(','):
        args += ['-f', config]
    return args + ['-f', str(RELEASE / filename)]


def current(state):
    assert metadata(APP) == state['app'], 'Live application changed; capture again before release'
    assert [metadata(name) for name in DEPENDENCIES] == state['dependencies']
    for file in FILES:
        assert (digest(docker('exec', APP, 'cat', '/app/' + file)) if state['before'][file] else None) == state['before'][file]
        assert digest((SERVER / file).read_bytes()) == state['workspaceAfter'][file]


def capture():
    assert not (RELEASE / 'manifest.json').exists(), 'Release already captured'
    RELEASE.mkdir(parents=True, exist_ok=True)
    state = {'app': metadata(APP), 'dependencies': [metadata(name) for name in DEPENDENCIES], 'before': {}, 'after': {}, 'workspaceAfter': {}}
    candidate = TASK / 'candidate-runtime'
    if candidate.exists(): shutil.rmtree(candidate)
    candidate.mkdir(exist_ok=True)
    for folder in ['src', 'public', 'migrations']:
        (candidate / folder).mkdir(exist_ok=True)
        docker('cp', APP + ':/app/' + folder + '/.', str(candidate / folder))
    subprocess.run(['sudo', '-n', 'chown', '-R', '1000:1000', str(candidate)], check=True)
    for file in FILES:
        baseline = TASK / 'baseline' / file
        live = candidate / file
        before = live.read_bytes() if live.exists() else None
        desired = (SERVER / file).read_bytes()
        state['workspaceAfter'][file] = digest(desired)
        if baseline.exists():
            assert before is not None
            if before != baseline.read_bytes():
                desired_text=desired.decode()
                first_import="import {mountStockRequestConversationRoutes} from './stock-request-conversation-router.js';\n" if file=='src/server.js' else ''
                if first_import: desired_text=desired_text.removeprefix(first_import)
                patch = ''.join(difflib.unified_diff(baseline.read_text().splitlines(True),desired_text.splitlines(True),fromfile=file,tofile=file))
                result = subprocess.run(['patch','--batch','--fuzz=0',str(live)],input=patch,text=True,capture_output=True)
                assert result.returncode == 0, 'Scoped patch conflicts with live ' + file + ': ' + result.stdout
                after = first_import.encode()+live.read_bytes()
            else:
                after = desired
        else:
            assert before is None, 'New file already exists in live runtime: ' + file
            after = desired
        state['before'][file], state['after'][file] = digest(before) if before is not None else None, digest(after)
        for folder, content in [('before', before), ('candidate', after)]:
            if content is None: continue
            target = RELEASE / folder / file
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(content)
        live.parent.mkdir(parents=True,exist_ok=True)
        live.write_bytes(after)
    current(state)
    save('manifest.json', state)
    print(json.dumps({'captured': True, 'files': FILES}), flush=True)


def evidence(state):
    summary = json.loads((OUT / 'summary.json').read_text())
    assert summary['tests'] == summary['passed'] + summary['failures'] and summary['tests'] >= 25
    assert summary['newFailures'] == 0 and summary['failures'] == summary['knownBaselineFailures'] == 1
    manifest = json.loads((OUT / 'source-manifest.json').read_text())
    assert all(manifest[file] == state['after'][file] for file in FILES)
    cleanup = json.loads((OUT / 'release-cleanup.json').read_text())
    assert cleanup['teardownExit'] == 0 and cleanup['productionHealthy']
    assert not cleanup['ownContainers'] and not cleanup['networks'] and not cleanup['volumes']


def prepare():
    state = json.loads((RELEASE / 'manifest.json').read_text())
    current(state)
    evidence(state)
    state['baseTag'] = 'mbbs-operator-app:stock-conversation-base-' + state['app']['imageId'].split(':')[-1][:12]
    (RELEASE / 'candidate/Dockerfile').write_text('FROM ' + state['baseTag'] + '\n' + ''.join(
        'COPY --chown=node:node ' + file + ' /app/' + file + '\n' for file in FILES))
    (RELEASE / 'compose.release.yml').write_text('services:\n  app:\n    image: ' + IMAGE + '\n')
    (RELEASE / 'compose.rollback.yml').write_text('services:\n  app:\n    image: ' + state['app']['imageId'] + '\n')
    docker('tag', state['app']['imageId'], state['baseTag'])
    with (RELEASE / 'build.log').open('wb') as log:
        subprocess.run(['sudo', '-n', 'docker', 'build', '--pull=false', '--network=none', '-t', IMAGE, str(RELEASE / 'candidate')],
                       stdout=log, stderr=subprocess.STDOUT, check=True, timeout=120)
    state['candidateImageId'] = docker('image', 'inspect', '--format', '{{.Id}}', IMAGE).decode().strip()
    before = json.loads(subprocess.check_output(compose(state, 'compose.rollback.yml') + ['config', '--format', 'json'], cwd=ROOT))
    after = json.loads(subprocess.check_output(compose(state, 'compose.release.yml') + ['config', '--format', 'json'], cwd=ROOT))
    before['services']['app'].pop('image')
    assert after['services']['app'].pop('image') == IMAGE
    assert before == after, 'Unexpected runtime configuration changes'
    save('manifest.json', state)
    print(json.dumps({'prepared': True, 'files': FILES}), flush=True)


def verify(state):
    core.ready(state['candidateImageId'])
    assert metadata(APP)['configuration'] == state['app']['configuration']
    assert [metadata(name) for name in DEPENDENCIES] == state['dependencies']
    for file in FILES:
        assert digest(docker('exec', APP, 'cat', '/app/' + file)) == state['after'][file]
    result = {'deployed': True, 'at': datetime.datetime.now(datetime.timezone.utc).isoformat(),
        'image': IMAGE, 'runtimeHashes': state['after'], 'configurationPreserved': True,
        'dependenciesUnchanged': True, 'databaseMigrations': 1, 'liveMessagesSent': 0, 'liveClosureActions': 0,
        'dockerPs': docker('ps', '--format', '{{.Names}} {{.Status}}').decode(),
        'dockerPsA': docker('ps', '-a', '--format', '{{.Names}} {{.Status}}').decode()}
    save('deployment-result.json', result)
    shutil.copy2(RELEASE / 'deployment-result.json', OUT / 'deployment-result.json')
    print(json.dumps({key: value for key, value in result.items() if key not in ['dockerPs', 'dockerPsA', 'runtimeHashes']}), flush=True)


def apply():
    state = json.loads((RELEASE / 'manifest.json').read_text())
    current(state)
    evidence(state)
    assert docker('image', 'inspect', '--format', '{{.Id}}', IMAGE).decode().strip() == state['candidateImageId']
    resolved = json.loads(subprocess.check_output(compose(state, 'compose.release.yml') + ['config', '--format', 'json'], cwd=ROOT))['services']['app']
    image_config = json.loads(docker('image', 'inspect', IMAGE))[0]['Config']
    runtime_config = json.loads(docker('inspect', APP))[0]['Config']
    expected_env = dict(entry.split('=', 1) for entry in image_config['Env'])
    expected_env.update({key: str(value) for key, value in resolved.get('environment', {}).items()})
    assert expected_env == dict(entry.split('=', 1) for entry in runtime_config['Env']), 'Environment would change'
    for field, option in [('Cmd', 'command'), ('Entrypoint', 'entrypoint'), ('User', 'user'), ('WorkingDir', 'working_dir')]:
        assert (resolved.get(option) if resolved.get(option) is not None else image_config.get(field)) == runtime_config.get(field)
    active = docker('exec', '-i', '-w', '/app', APP, 'node', '--input-type=module', input=b"import {query,closeDb} from './src/db.js';try{console.log(JSON.stringify((await query(\"SELECT (SELECT count(*) FROM operator_netsuite_posting_commands WHERE status IN ('posting','finalizing')) + (SELECT count(*) FROM sales_special_stock_cases WHERE closure_review->>'status'='applying') AS count\")).rows[0]));}finally{await closeDb();}")
    assert int(json.loads(active)['count']) == 0, 'An order operation is in progress'
    current(state)
    docker('cp', str(RELEASE / 'candidate/migrations/293_stock_request_conversation_reads.sql'), APP + ':/tmp/293_stock_request_conversation_reads.sql')
    try:
        migration = docker('exec','-i','-w','/app',APP,'node','--input-type=module',input=b'import fs from \'node:fs\';import {query,withTransaction,closeDb} from \'./src/db.js\';try{await withTransaction(async()=>{await query("SET LOCAL lock_timeout=\'5s\'");await query("SET LOCAL statement_timeout=\'30s\'");if(!(await query(\'SELECT 1 FROM schema_migrations WHERE filename=$1\',[\'293_stock_request_conversation_reads.sql\'])).rowCount){await query(fs.readFileSync(\'/tmp/293_stock_request_conversation_reads.sql\',\'utf8\'));await query(\'INSERT INTO schema_migrations(filename) VALUES($1)\',[\'293_stock_request_conversation_reads.sql\']);}});console.log(\'Conversation read-receipt migration applied\');}finally{await closeDb();}')
        (RELEASE / 'migration.log').write_bytes(migration)
    finally:
        docker('exec',APP,'rm','-f','/tmp/293_stock_request_conversation_reads.sql')
    try:
        with (RELEASE / 'publish.log').open('wb') as log:
            subprocess.run(compose(state, 'compose.release.yml') + ['up', '-d', '--no-build', '--no-deps', '--pull', 'never', 'app'],
                           cwd=ROOT, stdout=log, stderr=subprocess.STDOUT, check=True, timeout=100)
        verify(state)
    except Exception:
        with (RELEASE / 'rollback.log').open('wb') as log:
            subprocess.run(compose(state, 'compose.rollback.yml') + ['up', '-d', '--no-build', '--no-deps', '--pull', 'never', 'app'],
                           cwd=ROOT, stdout=log, stderr=subprocess.STDOUT, check=True, timeout=100)
        core.ready(state['app']['imageId'])
        save('rollback-result.json', {'previousAppRestored': True})
        raise


def refresh_capture():
    state=json.loads((RELEASE / 'manifest.json').read_text())
    assert not (RELEASE / 'deployment-result.json').exists()
    assert metadata(APP)==state['app']
    assert [metadata(name) for name in DEPENDENCIES]==state['dependencies']
    for file,expected in state['before'].items():
        if expected: assert digest(docker('exec',APP,'cat','/app/'+file))==expected
    shutil.copy2(RELEASE / 'manifest.json',RELEASE / ('manifest-before-refresh-'+datetime.datetime.now().strftime('%H%M%S')+'.json'))
    (RELEASE / 'manifest.json').unlink()
    capture()


if __name__ == '__main__':
    {'capture': capture, 'refresh': refresh_capture, 'prepare': prepare, 'apply': apply}[sys.argv[1]]()
