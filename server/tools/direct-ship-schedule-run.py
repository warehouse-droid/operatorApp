"""Run schedule regression tests in a dedicated database on the isolated runner."""
import io
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tarfile
from urllib.parse import urlsplit

SERVER = Path(__file__).resolve().parents[1]
RELEASE = SERVER / 'deployments/direct-ship-schedule-20261002'
RUNNER = 'mbbs-special-review-runner'
DATABASE_CONTAINER = 'mbbs-special-review-db'
DATABASE_NAME = 'scm_direct_ship_schedule_20261002'
REMOTE = '/tmp/direct-ship-schedule-20261002'


def docker(*args, **kwargs):
    return subprocess.check_output(['sudo', '-n', 'docker', *args], **kwargs)


def test_environment():
    row = json.loads(docker('inspect', RUNNER))[0]
    env = dict(value.split('=', 1) for value in row['Config']['Env'])
    url = urlsplit(env['DATABASE_URL'])
    assert env['MBT_TEST_ISOLATED'] == '1'
    assert env['NETSUITE_DIRECT_ACCESS_ENABLED'] == 'false'
    assert url.hostname == DATABASE_CONTAINER
    return url


def setup(reset=False):
    url = test_environment()
    fixture = RELEASE / 'test-database-fixture.sql'
    if not fixture.exists():
        fixture.write_bytes(docker('exec', DATABASE_CONTAINER, 'pg_dump', '-U', url.username, '-d', 'mbt_verify', '--no-owner', '--no-acl'))
        fixture.chmod(0o600)
    exists = docker('exec', DATABASE_CONTAINER, 'psql', '-U', url.username, '-d', 'postgres', '-XAt',
                    '-c', "SELECT 1 FROM pg_database WHERE datname='" + DATABASE_NAME + "'").decode().strip()
    if reset and exists:
        # This exact database belongs only to this schedule test run.
        docker('exec', DATABASE_CONTAINER, 'dropdb', '--force', '-U', url.username, DATABASE_NAME)
        exists = False
    if not exists:
        docker('exec', DATABASE_CONTAINER, 'createdb', '-U', url.username, DATABASE_NAME)
        docker('exec', '-i', DATABASE_CONTAINER, 'psql', '-U', url.username, '-d', DATABASE_NAME,
               '-Xq', '-v', 'ON_ERROR_STOP=1', input=fixture.read_bytes())
    print(json.dumps({'isolatedDatabaseReady': True, 'database': DATABASE_NAME}), flush=True)


def sync(source='workspace'):
    test_environment()
    stage = RELEASE / ('validation-' + source)
    if stage.exists():
        shutil.rmtree(stage)
    stage.mkdir()
    base = SERVER if source == 'workspace' else RELEASE / source
    for folder in ['src', 'public', 'migrations']:
        shutil.copytree(base / folder, stage / folder)
    for folder in ['test']:
        shutil.copytree(SERVER / folder, stage / folder)
    for file in ['package.json', 'package-lock.json']:
        shutil.copy2(base / file, stage / file)
    docker('exec', RUNNER, 'node', '-e',
           "const fs=require('fs'),p=process.argv[1];fs.rmSync(p,{recursive:true,force:true});fs.mkdirSync(p)", REMOTE)
    with io.BytesIO() as archive_data:
        with tarfile.open(fileobj=archive_data, mode='w') as archive:
            for child in stage.iterdir():
                archive.add(child, arcname=child.name)
        docker('exec', '-i', RUNNER, 'tar', '-xf', '-', '-C', REMOTE, input=archive_data.getvalue())
    docker('exec', RUNNER, 'node', '-e',
           "require('fs').symlinkSync('/app/node_modules',process.argv[1]+'/node_modules','dir')", REMOTE)
    print(json.dumps({'synced': source}), flush=True)


def run(label, command):
    if command[:2] == ['node', '--test']:
        setup(reset=True)
    url = test_environment()._replace(path='/' + DATABASE_NAME).geturl()
    args = ['sudo', '-n', 'docker', 'exec', '-e', 'DATABASE_URL=' + url,
            '-e', 'MBT_TEST_ISOLATED=1', '-e', 'NETSUITE_DIRECT_ACCESS_ENABLED=false',
            '-e', 'NETSUITE_MIRROR_ROLE=disabled', '-e', 'MBBS_ENV_FILE=.env.schedule-test-nonexistent',
            '-e', 'PLAYWRIGHT_BROWSERS_PATH=/browsers', '-w', REMOTE, RUNNER, *command]
    logfile = RELEASE / (label + '.log')
    with logfile.open('wb') as log:
        result = subprocess.run(args, stdout=log, stderr=subprocess.STDOUT, timeout=600)
    output = logfile.read_text()
    print(json.dumps({'label': label, 'exitCode': result.returncode, 'tail': output[-7000:]}), flush=True)
    return result.returncode


if __name__ == '__main__':
    action = sys.argv[1]
    if action == 'setup':
        setup()
    elif action == 'sync':
        sync(sys.argv[2] if len(sys.argv) > 2 else 'workspace')
    else:
        sys.exit(run(action, sys.argv[2:]))
