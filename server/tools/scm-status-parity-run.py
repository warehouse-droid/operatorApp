"""Run PO status regressions against captured sources in an isolated test database."""
import importlib.util
import difflib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
from urllib.parse import urlsplit

SERVER = Path(__file__).resolve().parents[1]
RELEASE = SERVER / 'deployments/scm-status-parity-20261001'
OUT = SERVER / 'test-artifacts/scm-status-parity-20261001'
RUNNER = 'mbbs-special-review-runner'
REMOTE = '/tmp/scm-status-parity-20261001'
DATABASE = 'scm_status_parity_20261001'


def docker(*args, **kwargs):
    return subprocess.check_output(['sudo', '-n', 'docker', *args], **kwargs)


def environment():
    row = json.loads(docker('inspect', RUNNER))[0]
    values = dict(value.split('=', 1) for value in row['Config']['Env'])
    url = urlsplit(values['DATABASE_URL'])
    assert values['MBT_TEST_ISOLATED'] == '1'
    assert values['NETSUITE_DIRECT_ACCESS_ENABLED'] == 'false'
    assert url.hostname == 'mbbs-special-review-db' and url.username == 'mbt_test'
    return url._replace(path='/' + DATABASE).geturl()


def stage(baseline=False):
    source = RELEASE / ('before' if baseline else 'candidate')
    destination = RELEASE / 'validation'
    if destination.exists():
        shutil.rmtree(destination)
    shutil.copytree(source, destination)
    shutil.copytree(SERVER / 'test', destination / 'test')
    (destination / 'tools').mkdir(exist_ok=True)
    for name in ['eslint.mbt.config.js', 'tsconfig.mbt.json']:
        shutil.copy2(SERVER / name, destination / name)
    for name in ['tools/stock-request-layout-eslint.config.mjs', 'tools/special-workflow-queue-eslint.config.mjs',
                 'tools/special-workflow-native-eslint.config.mjs', 'tools/special-workflow-link-eslint.config.mjs',
                 'tools/special-workflow-eslint.config.mjs', 'tools/scm-status-parity-check.mjs',
                 'tools/scm-status-parity-browser.mjs']:
        shutil.copy2(SERVER / name, destination / name)
    before = destination / 'test-artifacts/scm-status-parity-20261001/before'
    patch = ''
    for name in ['src/dispatch-repository.js', 'src/scm-purchase-order-catalog-repository.js',
                 'public/dispatch-scm.js', 'public/dispatch-scm.html']:
        (before / name).parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(RELEASE / 'before' / name, before / name)
        patch += ''.join(difflib.unified_diff((RELEASE / 'before' / name).read_text().splitlines(True),
            (source / name).read_text().splitlines(True), fromfile='a/' + name, tofile='b/' + name))
    (before.parent / 'changes.patch').write_text(patch)
    docker('exec', RUNNER, 'node', '-e',
           "const fs=require('fs'),p=process.argv[1];fs.rmSync(p,{recursive:true,force:true});fs.mkdirSync(p)", REMOTE)
    docker('cp', str(destination) + '/.', RUNNER + ':' + REMOTE)
    docker('exec', RUNNER, 'node', '-e',
           "require('fs').symlinkSync('/app/node_modules',process.argv[1]+'/node_modules','dir')", REMOTE)
    print(json.dumps({'staged': True, 'baseline': baseline}), flush=True)


def run(label, command):
    OUT.mkdir(parents=True, exist_ok=True)
    args = ['sudo', '-n', 'docker', 'exec', '-e', 'DATABASE_URL=' + environment(),
            '-e', 'MBT_TEST_ISOLATED=1', '-e', 'NETSUITE_DIRECT_ACCESS_ENABLED=false',
            '-e', 'NETSUITE_MIRROR_ROLE=disabled', '-e', 'MBBS_ENV_FILE=/nonexistent',
            '-e', 'PLAYWRIGHT_BROWSERS_PATH=/browsers', '-w', REMOTE, RUNNER, *command]
    with (OUT / (label + '.log')).open('wb') as log:
        result = subprocess.run(args, stdout=log, stderr=subprocess.STDOUT, timeout=300)
    output = (OUT / (label + '.log')).read_text()
    print(json.dumps({'label': label, 'exitCode': result.returncode, 'tail': output[-4500:]}), flush=True)
    return result.returncode


if __name__ == '__main__':
    os.umask(0o077)
    mode = sys.argv[1]
    if mode == 'setup':
        environment()
        exists = docker('exec', 'mbbs-special-review-db', 'psql', '-U', 'mbt_test', '-d', 'postgres',
                        '-XAt', '-c', "SELECT count(*) FROM pg_database WHERE datname='" + DATABASE + "'").decode().strip()
        assert exists == '0', 'This task database already exists'
        docker('exec', 'mbbs-special-review-db', 'createdb', '-U', 'mbt_test', DATABASE)
        stage(True)
        sys.exit(run('migrations', ['node', 'src/migrate.js']))
    elif mode in ['baseline', 'stage']:
        stage(mode == 'baseline')
    else:
        sys.exit(run(mode, sys.argv[2:]))
