"""Run item/copy checks against the isolated test database and frozen live baseline."""
import importlib.util
import io
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tarfile

SERVER = Path(__file__).resolve().parents[1]
OUT = SERVER / 'test-artifacts/special-case-edits-20261001'
RELEASE = SERVER / 'deployments/special-case-edits-20261001'
REMOTE = '/tmp/special-case-edits-20261001'
spec = importlib.util.spec_from_file_location('items_test_runner', SERVER / 'tools/special-po-so-note-run.py')
runner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runner)
runner.OUT, runner.REMOTE = OUT, REMOTE
docker, run = runner.docker, runner.run


def coverage_diffs():
    files = json.loads((SERVER / 'tools/special-case-edits-files.json').read_text())
    data = {'algorithm': 'git histogram', 'gitVersion': subprocess.check_output(['git', '--version'], text=True).strip(), 'files': {}}
    for file in files:
        if not file.endswith('.js'):
            continue
        before, after = RELEASE / 'before' / file, RELEASE / 'candidate' / file
        result = subprocess.run(['git', 'diff', '--no-index', '--diff-algorithm=histogram', '--unified=0',
                                 str(before) if before.exists() else '/dev/null', str(after)], text=True, capture_output=True)
        assert result.returncode in [0, 1]
        data['files'][file] = {'sourceHash': hashlib.sha256(after.read_bytes()).hexdigest(),
                              'baselineHash': hashlib.sha256(before.read_bytes()).hexdigest() if before.exists() else None,
                              'diff': result.stdout}
    encoded = (json.dumps(data, indent=2) + '\n').encode()
    (OUT / 'changed-diffs.json').write_bytes(encoded)
    docker('exec', '-i', runner.RUNNER, 'node', '-e', "require('fs').writeFileSync(process.argv[1],require('fs').readFileSync(0))",
           REMOTE + '/test-artifacts/special-case-edits-20261001/changed-diffs.json', input=encoded)


def sync():
    root = RELEASE / 'validation'
    if root.exists():
        shutil.rmtree(root)
    shutil.copytree(RELEASE / ('candidate' if (RELEASE / 'candidate').exists() else 'before'), root)
    if not (RELEASE / 'candidate').exists():
        shutil.copy2(OUT / 'red-stub.js', root / 'public/special-stock-case-edits.js')
    for folder in ['test', 'tools']:
        shutil.copytree(SERVER / folder, root / folder)
    shutil.copytree(OUT / 'before', root / 'test-artifacts/special-case-edits-20261001/before')
    for name in ['red-stub.js', 'red-tests.log', 'red-browser.log']:
        shutil.copy2(OUT / name, root / 'test-artifacts/special-case-edits-20261001' / name)
    if (SERVER / 'netsuite-smart-scm-picking-ticket-restlet.js').exists():
        shutil.copy2(SERVER / 'netsuite-smart-scm-picking-ticket-restlet.js', root / 'netsuite-smart-scm-picking-ticket-restlet.js')
    docker('exec', runner.RUNNER, 'node', '-e', "const fs=require('fs'),p=process.argv[1];fs.rmSync(p,{recursive:true,force:true});fs.mkdirSync(p)", REMOTE)
    docker('cp', str(root) + '/.', runner.RUNNER + ':' + REMOTE)
    docker('exec', runner.RUNNER, 'node', '-e', "require('fs').symlinkSync('/app/node_modules',process.argv[1]+'/node_modules','dir')", REMOTE)
    if (RELEASE / 'candidate').exists():
        coverage_diffs()


def collect():
    with tarfile.open(fileobj=io.BytesIO(docker('cp', runner.RUNNER + ':' + REMOTE + '/test-artifacts/special-case-edits-20261001/.', '-'))) as archive:
        archive.extractall(OUT, filter='data')


if __name__ == '__main__':
    os.umask(0o077)
    action = sys.argv[1]
    if action == 'sync':
        sync()
    elif action == 'collect':
        collect()
    else:
        sys.exit(run(action, sys.argv[2:]))
