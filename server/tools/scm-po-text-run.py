"""Run feature checks against existing isolated tools, never production credentials."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
from urllib.parse import urlsplit

SERVER = Path(__file__).resolve().parents[1]
OUT = SERVER / 'test-artifacts/scm-po-text-20260930'
RUNNER = 'mbbs-special-review-runner'
REMOTE = '/tmp/scm-po-text-20260930'


def docker(*args, **kwargs):
    return subprocess.check_output(['sudo', '-n', 'docker', *args], **kwargs)


def sync(baseline=False):
    stage = OUT / 'runner-source'
    if stage.exists():
        shutil.rmtree(stage)
    stage.mkdir()
    for folder in ['src', 'public', 'migrations', 'test', 'tools']:
        shutil.copytree(SERVER / folder, stage / folder)
    for file in ['package.json', 'package-lock.json', 'netsuite-smart-scm-picking-ticket-restlet.js']:
        shutil.copy2(SERVER / file, stage / file)
    shutil.copytree(OUT / 'before', stage / 'test-artifacts/scm-po-text-20260930/before')
    if baseline:
        for file in (OUT / 'before').rglob('*'):
            if file.is_file():
                shutil.copy2(file, stage / file.relative_to(OUT / 'before'))
    docker('exec', RUNNER, 'node', '-e',
           "const fs=require('fs'),p=process.argv[1];fs.rmSync(p,{recursive:true,force:true});fs.mkdirSync(p)", REMOTE)
    docker('cp', str(stage) + '/.', RUNNER + ':' + REMOTE)
    docker('exec', RUNNER, 'node', '-e',
           "require('fs').symlinkSync('/app/node_modules',process.argv[1]+'/node_modules','dir')", REMOTE)


def run(label, command):
    info = json.loads(docker('inspect', RUNNER))[0]
    env = dict(value.split('=', 1) for value in info['Config']['Env'])
    assert env['MBT_TEST_ISOLATED'] == '1' and env['NETSUITE_DIRECT_ACCESS_ENABLED'] == 'false'
    database = urlsplit(env['DATABASE_URL'])
    assert database.hostname == 'mbbs-special-review-db'
    database = database._replace(path='/mbt_verify').geturl()
    args = ['sudo', '-n', 'docker', 'exec', '-e', 'DATABASE_URL=' + database,
            '-e', 'MBT_TEST_ISOLATED=1', '-e', 'NETSUITE_DIRECT_ACCESS_ENABLED=false',
            '-e', 'PLAYWRIGHT_BROWSERS_PATH=/browsers', '-e', 'MBBS_ENV_FILE=/nonexistent',
            '-e', 'SPECIAL_BATCH_BROWSER_OUTPUT=' + REMOTE + '/test-artifacts/scm-po-text-20260930/browser',
            '-w', REMOTE, RUNNER, *command]
    with (OUT / (label + '.log')).open('wb') as log:
        result = subprocess.run(args, stdout=log, stderr=subprocess.STDOUT, timeout=600)
    log = (OUT / (label + '.log')).read_text()
    print(json.dumps({'label': label, 'exitCode': result.returncode,
                      'tail': log[-3500:]}), flush=True)
    return result.returncode


if __name__ == '__main__':
    os.umask(0o077)
    command = sys.argv[1]
    if command in ['sync', 'baseline']:
        sync(command == 'baseline')
        print(json.dumps({'synced': True, 'baseline': command == 'baseline'}))
    elif command == 'collect':
        docker('cp', RUNNER + ':' + REMOTE + '/test-artifacts/scm-po-text-20260930/.', str(OUT))
    elif command == 'push':
        runtime_files = set(json.loads((SERVER / 'tools/scm-po-text-files.json').read_text()))
        for file in sys.argv[2:]:
            path = Path(file)
            assert '..' not in path.parts and (path.parts[0] in ['test', 'tools'] or file in runtime_files)
            docker('cp', str(SERVER / path), RUNNER + ':' + REMOTE + '/' + file)
    else:
        sys.exit(run(command, sys.argv[2:]))
