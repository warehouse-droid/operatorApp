"""Run Resolve checks only in the existing isolated review environment."""
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

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'test-artifacts/regular-stock-resolve-20261002'
REMOTE = '/tmp/regular-stock-resolve-20261002'
RELEASE = ROOT / 'deployments/regular-stock-resolve-20261002'
spec = importlib.util.spec_from_file_location('resolve_review', ROOT / 'tools/special-delivery-fee-run.py')
review = importlib.util.module_from_spec(spec)
spec.loader.exec_module(review)
review.OUT, review.REMOTE = OUT, REMOTE


def sync():
    source = RELEASE / 'candidate' if (RELEASE / 'candidate').exists() else ROOT
    stage = OUT / 'runner-source'
    if stage.exists():
        shutil.rmtree(stage)
    stage.mkdir()
    for folder in ['src', 'public', 'migrations', 'test', 'tools']:
        shutil.copytree((ROOT if folder in ['test', 'tools'] else source) / folder, stage / folder)
    for file in ['package.json', 'package-lock.json', 'netsuite-smart-scm-picking-ticket-restlet.js']:
        shutil.copy2((source if (source / file).exists() else ROOT) / file, stage / file)
    shutil.copytree(OUT / 'before', stage / 'test-artifacts/regular-stock-resolve-20261002/before')
    for name in ['baseline.json','baseline-tests.log']:
        if (OUT / name).exists():
            shutil.copy2(OUT / name, stage / 'test-artifacts/regular-stock-resolve-20261002' / name)
    diffs = {'files': {}}
    for file in json.loads((ROOT / 'tools/regular-stock-resolve-files.json').read_text()):
        if not file.endswith('.js'):
            continue
        old, new = OUT / 'before' / file, source / file
        result = subprocess.run(['git', 'diff', '--no-index', '--diff-algorithm=histogram', '--unified=0', str(old) if old.exists() else '/dev/null', str(new)], text=True, capture_output=True)
        assert result.returncode in [0, 1]
        diffs['files'][file] = {'sourceHash': hashlib.sha256(new.read_bytes()).hexdigest(), 'baselineHash': hashlib.sha256(old.read_bytes()).hexdigest() if old.exists() else None, 'diff': result.stdout}
    (OUT / 'changed-diffs.json').write_text(json.dumps(diffs))
    (stage / 'test-artifacts/regular-stock-resolve-20261002/changed-diffs.json').write_text(json.dumps(diffs))
    review.docker('exec', review.RUNNER, 'node', '-e', "const fs=require('fs'),p=process.argv[1];fs.rmSync(p,{recursive:true,force:true});fs.mkdirSync(p)", REMOTE)
    review.docker('cp', str(stage) + '/.', review.RUNNER + ':' + REMOTE)
    review.docker('exec', review.RUNNER, 'node', '-e', "require('fs').symlinkSync('/app/node_modules',process.argv[1]+'/node_modules','dir')", REMOTE)


def collect():
    with tarfile.open(fileobj=io.BytesIO(review.docker('cp', review.RUNNER + ':' + REMOTE + '/test-artifacts/regular-stock-resolve-20261002/.', '-'))) as archive:
        archive.extractall(OUT, filter='data')


if __name__ == '__main__':
    os.umask(0o077)
    if sys.argv[1] == 'sync':
        sync()
    elif sys.argv[1] == 'collect':
        collect()
    elif sys.argv[1] == 'gauntlet':
        sync()
        try:
            code = review.run('final-gauntlet', ['node', 'tools/regular-stock-resolve-check.mjs'])
        finally:
            collect()
        sys.exit(code)
    else:
        sys.exit(review.run(sys.argv[1], sys.argv[2:]))
