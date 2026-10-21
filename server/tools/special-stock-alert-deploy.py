"""Publish the verified Special alerts, quote requester and transfer ETA changes."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys

SERVER = Path(__file__).resolve().parents[1]
ROOT = SERVER.parent
RELEASE = SERVER / 'deployments/special-alerts-requester-transfer-20260928'
APP = 'mbbs-operator-app-app-1'
DEPENDENCIES = ['mbbs-operator-app-webhook-worker-1', 'mbbs-operator-app-db-1', 'mbbs-operator-app-ollama-1']
IMAGE = 'mbbs-operator-app:special-alerts-requester-transfer-20260928'
BASE_IMAGE = 'sha256:4ae48dc4ca6a764b5d6302affcc41fc1d1346d09f9c35180fd3deb505e28b3d2'
BEFORE = {"public/app-sidebar.js": "7045b49ddf63637d4cc053076b88287485cd0c47093bbfef483454d61375d877", "public/aggregate-requests.html": "9a7b0e08b47968074fdacdccf45475cc9a27ec96d0df99989466f7d046c2b92e", "public/operator.html": "cfeb23251abf1f1fcf91584969d7a3d344e529cdd812d192a1d024ed37db5146", "public/field-sales/index.html": "1b563d03d3d437824032dd2510f121394bb99304676d6c36bc381b887a0ceda7", "public/scm-special-stock-requests.js": "5133128878135cdbd0499487f49b014042343ad3ff0f94cae035b8f74d963bba", "public/scm-stock-requests.html": "92594bde7ca5bd731096b3a5e20d375826a3459c34f9a5dfdaa07b80c46dca84", "public/scm-menu.html": "b7aefd2cfd48831a40d7224e84b0de873fd79e3ae4fec10851e2aa8ab4ad026f", "src/special-stock-documents.js": "12a1c0e3aada277c61a4c6db46b1f188667d163ad9c6849ee7b1f62bd93f2855", "src/server.js": "df01cd9eb20dd5469ea579fed190ea5d06796150f5074059f50a40dd0df462cf", "src/special-stock-request-domain.js": "61c4ceb1e48ddf4ca2e047ac28420de3e87c2ca15568f9af9d9d79ac8cd970bb", "src/special-stock-request-repository.js": "d41714b820978c20e9edda7d0a0d9e3ce237bd56e59cabac446494f7ee94913c", "public/sales-special-stock-requests.js": "d487554e2ebf0736a17203a286e1c442b67952d6fec3f0bea61bb26118f60009", "public/sales-stock-requests.html": "57a50c76afdbfe0bc26ce083ba3cd6426880cfe861d2235606ddc097637b415b"}
ADDED = ['public/scm-special-alert.js', 'src/special-stock-alerts.js']
FILES = list(BEFORE) + ADDED
EVIDENCE = SERVER / 'test-artifacts/special-workflow-review/special-alert-20260928'
spec = importlib.util.spec_from_file_location('release_core', SERVER / 'tools/operator-display-settings-deploy.py')
core = importlib.util.module_from_spec(spec)
spec.loader.exec_module(core)
docker = core.docker

def hashes():
    return {name: hashlib.sha256((SERVER / name).read_bytes()).hexdigest() for name in FILES}

def live_hashes(files=FILES):
    rows = docker('exec', APP, 'sha256sum', *['/app/' + name for name in files]).decode().splitlines()
    return {row.split()[1].removeprefix('/app/'): row.split()[0] for row in rows}

def save(name, value):
    (RELEASE / name).write_text(json.dumps(value, indent=2) + '\n')

def compose(info, filename='compose.release.yml'):
    args = ['sudo', '-n', 'docker', 'compose', '-p', 'mbbs-operator-app']
    for name in info['app']['configFiles'].split(','):
        args += ['-f', name]
    return args + ['-f', str(RELEASE / filename), '--env-file', str(ROOT / 'docker/env/.env')]

def current(info):
    assert core.metadata(APP) == info['app'], 'Live application changed'
    assert [core.metadata(name) for name in DEPENDENCIES] == info['dependencies'], 'Dependency changed'
    assert hashes() == info['files'], 'Source changed'
    assert live_hashes(list(BEFORE)) == BEFORE, 'Live source changed'

def config_check(info):
    config = json.loads(subprocess.check_output(compose(info) + ['config', '--format', 'json'], cwd=ROOT))['services']['app']
    image = json.loads(docker('image', 'inspect', IMAGE))[0]['Config']
    live = json.loads(docker('inspect', APP))[0]['Config']
    env = dict(value.split('=', 1) for value in image['Env'])
    env.update({key: str(value) for key, value in config.get('environment', {}).items()})
    assert env == dict(value.split('=', 1) for value in live['Env']), 'Environment changed'
    for field, key in [('Cmd', 'command'), ('Entrypoint', 'entrypoint'), ('User', 'user'), ('WorkingDir', 'working_dir')]:
        assert (image.get(field) if config.get(key) is None else config[key]) == live.get(field), field + ' changed'

def prepare():
    os.umask(0o077)
    checks = json.loads((EVIDENCE / 'checks.json').read_text())
    assert checks['syntax'] and checks['lint'] and checks['pass'] == 21 and checks['fail'] == 0
    assert hashes() == json.loads((EVIDENCE / 'source-manifest.json').read_text()), 'Verified source changed'
    for name in ADDED:
        docker('exec', APP, 'test', '!', '-e', '/app/' + name)
    info = {'app': core.metadata(APP), 'dependencies': [core.metadata(name) for name in DEPENDENCIES], 'files': hashes()}
    assert info['app']['imageId'] == BASE_IMAGE
    current(info)
    RELEASE.mkdir(mode=0o700, exist_ok=True)
    assert not (RELEASE / 'manifest.json').exists(), 'Release is already prepared'
    stage = RELEASE / 'stage'
    for name in FILES:
        target = stage / name
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(SERVER / name, target)
    base_tag = info['app']['image']
    assert docker('image', 'inspect', '--format', '{{.Id}}', base_tag).decode().strip() == BASE_IMAGE
    assert sorted(str(path.relative_to(stage)) for path in stage.rglob('*') if path.is_file() and path.name != 'Dockerfile') == sorted(FILES)
    (stage / 'Dockerfile').write_text('FROM ' + base_tag + '\nCOPY --chown=node:node public/ /app/public/\nCOPY --chown=node:node src/ /app/src/\n')
    with (RELEASE / 'build.log').open('wb') as log:
        subprocess.run(['sudo', '-n', 'docker', 'build', '--network', 'none', '--pull=false', '-t', IMAGE, str(stage)], stdout=log, stderr=subprocess.STDOUT, check=True)
    info['imageId'] = docker('image', 'inspect', '--format', '{{.Id}}', IMAGE).decode().strip()
    (RELEASE / 'compose.release.yml').write_text('services:\n  app:\n    image: ' + IMAGE + '\n')
    rows = docker('run', '--rm', '--network', 'none', '--entrypoint', 'sha256sum', IMAGE, *['/app/' + name for name in FILES]).decode().splitlines()
    assert {row.split()[1].removeprefix('/app/'): row.split()[0] for row in rows} == info['files']
    current(info)
    config_check(info)
    save('manifest.json', info)
    print(json.dumps({'prepared': True, 'files': FILES, 'image': IMAGE, 'backups': False, 'regression': False}), flush=True)

def verify(info):
    core.ready(info['imageId'])
    actual = core.metadata(APP)
    assert actual['imageId'] == info['imageId']
    assert actual['configuration'] == info['app']['configuration'], 'Runtime configuration changed'
    assert [core.metadata(name) for name in DEPENDENCIES] == info['dependencies'], 'Dependency changed'
    assert live_hashes() == info['files']
    result = {'deployed': True, 'image': IMAGE, 'imageId': info['imageId'], 'files': FILES, 'configurationPreserved': True, 'dependenciesUnchanged': True, 'backups': False, 'regression': False}
    save('result.json', result)
    print(json.dumps(result), flush=True)

def apply():
    info = json.loads((RELEASE / 'manifest.json').read_text())
    current(info)
    config_check(info)
    sql = """SELECT json_build_object(
      'operatorPosting',(SELECT count(*) FROM operator_netsuite_posting_commands WHERE status IN ('queued','posting','finalizing')),
      'driverExecuting',(SELECT count(*) FROM driver_foreground_action_receipts WHERE status='executing'),
      'specialCreating',(SELECT count(*) FROM sales_special_stock_cases WHERE sales_order_operation_status='creating' OR purchase_order_operation_status='creating'),
      'quantityApplying',(SELECT count(*) FROM sales_special_stock_cases WHERE quantity_review->>'status'='applying'))"""
    active = json.loads(docker('exec', 'mbbs-operator-app-db-1', 'psql', '-U', 'mbbs_app', '-d', 'mbbs_yard', '-XAt', '-v', 'ON_ERROR_STOP=1', '-c', sql))
    assert not any(active.values()), 'Wait for active work before app restart'
    current(info)
    try:
        with (RELEASE / 'publish.log').open('wb') as log:
            subprocess.run(compose(info) + ['up', '-d', '--no-build', '--no-deps', '--pull', 'never', 'app'], cwd=ROOT, stdout=log, stderr=subprocess.STDOUT, check=True, timeout=60)
        verify(info)
    except Exception:
        (RELEASE / 'compose.restore.yml').write_text('services:\n  app:\n    image: ' + BASE_IMAGE + '\n')
        with (RELEASE / 'restore.log').open('wb') as log:
            subprocess.run(compose(info, 'compose.restore.yml') + ['up', '-d', '--no-build', '--no-deps', '--pull', 'never', 'app'], cwd=ROOT, stdout=log, stderr=subprocess.STDOUT, check=True, timeout=60)
        core.ready(BASE_IMAGE)
        raise

if __name__ == '__main__':
    {'prepare': prepare, 'apply': apply}[sys.argv[1]]()
