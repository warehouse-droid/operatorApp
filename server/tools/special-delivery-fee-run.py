"""Run only in the existing isolated review container; never expose credentials."""
import importlib.util
import hashlib
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tarfile
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'test-artifacts/special-delivery-fee-20261001'
REMOTE = '/tmp/special-delivery-fee-20261001'
RUNNER = 'mbbs-special-review-runner'

def docker(*args, **kwargs):
    return subprocess.check_output(['sudo', '-n', 'docker', *args], **kwargs)

def sync():
    candidate = ROOT / 'deployments/special-delivery-fee-20261001/candidate'
    source = candidate if candidate.exists() else ROOT
    stage = OUT / 'runner-source'
    if stage.exists():
        shutil.rmtree(stage)
    stage.mkdir(parents=True)
    for folder in ['src', 'public', 'migrations', 'test', 'tools']:
        shutil.copytree((ROOT if folder in ['test', 'tools'] else source) / folder, stage / folder)
    for file in ['package.json', 'package-lock.json', 'netsuite-smart-scm-picking-ticket-restlet.js']:
        shutil.copy2((source if (source / file).exists() else ROOT) / file, stage / file)
    shutil.copytree(OUT / 'before', stage / 'test-artifacts/special-delivery-fee-20261001/before')
    for name in ['baseline-tests.log', 'baseline-hashes.json']:
        if (OUT / name).exists():
            shutil.copy2(OUT / name, stage / 'test-artifacts/special-delivery-fee-20261001' / name)
    docker('exec', RUNNER, 'node', '-e', "const fs=require('fs'),p=process.argv[1];fs.rmSync(p,{recursive:true,force:true});fs.mkdirSync(p)", REMOTE)
    docker('cp', str(stage) + '/.', RUNNER + ':' + REMOTE)
    docker('exec', RUNNER, 'node', '-e', "require('fs').symlinkSync('/app/node_modules',process.argv[1]+'/node_modules','dir')", REMOTE)
    diffs = {'files': {}}
    for file in json.loads((ROOT / 'tools/special-delivery-fee-files.json').read_text()):
        if not file.endswith('.js'):
            continue
        old, new = OUT / 'before' / file, source / file
        result = subprocess.run(['git', 'diff', '--no-index', '--diff-algorithm=histogram', '--unified=0', str(old) if old.exists() else '/dev/null', str(new)], text=True, capture_output=True)
        assert result.returncode in [0, 1]
        diffs['files'][file] = {'sourceHash': hashlib.sha256(new.read_bytes()).hexdigest(), 'baselineHash': hashlib.sha256(old.read_bytes()).hexdigest() if old.exists() else None, 'diff': result.stdout}
    encoded = json.dumps(diffs).encode()
    (OUT / 'changed-diffs.json').write_bytes(encoded)
    docker('exec', '-i', RUNNER, 'node', '-e', "require('fs').writeFileSync(process.argv[1],require('fs').readFileSync(0))", REMOTE + '/test-artifacts/special-delivery-fee-20261001/changed-diffs.json', input=encoded)

def run(label, command):
    info = json.loads(docker('inspect', RUNNER))[0]
    env = dict(value.split('=', 1) for value in info['Config']['Env'])
    assert env['MBT_TEST_ISOLATED'] == '1' and env['NETSUITE_DIRECT_ACCESS_ENABLED'] == 'false'
    database = urlsplit(env['DATABASE_URL'])
    assert database.hostname == 'mbbs-special-review-db'
    args = ['sudo', '-n', 'docker', 'exec', '-e', 'DATABASE_URL=' + database._replace(path='/mbt_verify').geturl(),
            '-e', 'MBT_TEST_ISOLATED=1', '-e', 'NETSUITE_DIRECT_ACCESS_ENABLED=false',
            '-e', 'PLAYWRIGHT_BROWSERS_PATH=/browsers', '-e', 'MBBS_ENV_FILE=/nonexistent', '-w', REMOTE, RUNNER, *command]
    with (OUT / (label + '.log')).open('wb') as log:
        result = subprocess.run(args, stdout=log, stderr=subprocess.STDOUT, timeout=900)
    print(json.dumps({'label': label, 'exitCode': result.returncode, 'tail': (OUT / (label + '.log')).read_text()[-5000:]}), flush=True)
    return result.returncode

if __name__ == '__main__':
    os.umask(0o077)
    if sys.argv[1] == 'sync':
        sync()
    elif sys.argv[1] == 'collect':
        with tarfile.open(fileobj=io.BytesIO(docker('cp', RUNNER + ':' + REMOTE + '/test-artifacts/special-delivery-fee-20261001/.', '-'))) as archive:
            archive.extractall(OUT, filter='data')
    else:
        sys.exit(run(sys.argv[1], sys.argv[2:]))
