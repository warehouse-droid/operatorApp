"""Ship the Dispatch event-target correction without replacing other live work."""
import atexit
import importlib.util
import io
import json
from pathlib import Path
import shutil
import sys
import tarfile

SERVER = Path(__file__).resolve().parents[1]
ARTIFACT = SERVER / 'test-artifacts/dispatch-refresh-targets-20261019'
spec = importlib.util.spec_from_file_location('freshness_release', SERVER / 'tools/dispatch-freshness-release.py')
f = importlib.util.module_from_spec(spec)
spec.loader.exec_module(f)
r = f.r
r.RELEASE = SERVER / 'deployments/dispatch-refresh-targets-20261019'
r.IMAGE = 'mbbs-operator-app:dispatch-refresh-targets-20261019'
r.ROLLBACK = r.IMAGE + '-rollback'
r.READ_NAME = 'mbbs-dispatch-refresh-targets-reader'
r.CHECK_NAME = 'mbbs-dispatch-refresh-targets-check'
f.SCRIPT_URL = '/dispatch.js?v=20261019-dispatch-refresh-targets-v1'
FILES = ['public/dispatch.html', 'public/dispatch.js']


def prepare():
    evidence = json.loads((ARTIFACT / 'results/refresh-targets-evidence.json').read_text())
    assert evidence['browser']['exit'] == evidence['properties']['exit'] == 0
    assert len(evidence['mutations']) == 9 and all(row['killed'] for row in evidence['mutations'])
    assert evidence['changedLineCoverage']['missing'] == []
    assert evidence['replay']['consistencyChecks'] == 51
    r.RELEASE.mkdir(parents=True, exist_ok=False)
    app = r.metadata(r.APP)
    dependencies = [r.metadata(n) for n in r.DEPENDENCIES]
    before = r.RELEASE / 'before'
    before.mkdir()
    archive = r.docker('exec', r.APP, 'tar', '-cf', '-', '-C', '/app',
                       'src', 'public', 'migrations', 'package.json', 'package-lock.json')
    with tarfile.open(fileobj=io.BytesIO(archive)) as stream:
        stream.extractall(before, filter='data')
    for p in before.rglob('*'):
        p.chmod(p.stat().st_mode | (0o055 if p.is_dir() else 0o044))
    candidate = r.RELEASE / 'candidate'
    shutil.copytree(before, candidate)
    for name in FILES:
        assert (before / name).read_bytes() == (ARTIFACT / 'before' / name).read_bytes(), 'Live browser changed'
        assert (SERVER / name).read_bytes() == (ARTIFACT / 'candidate' / name).read_bytes(), 'Tested source changed'
        shutil.copy2(SERVER / name, candidate / name)
    tree = r.files_at(candidate)
    assert tree == r.files_at(ARTIFACT / 'candidate'), 'Production changed: validate the combined candidate again'
    assert all(tree[n] == digest for n, digest in evidence['replay']['runtimeHashes'].items())
    before_tree = r.files_at(before)
    assert sorted(n for n in tree if tree[n] != before_tree.get(n)) == FILES
    data = {'app': app, 'dependencies': dependencies, 'beforeTree': before_tree,
            'candidateTree': tree, 'files': FILES, 'capturedAt': r.now(),
            'candidateTreeHash': r.sha(json.dumps(tree, sort_keys=True).encode()),
            'workspace': {n: r.sha((SERVER / n).read_bytes()) for n in FILES},
            'packages': {n: r.sha((candidate / n).read_bytes()) for n in ['package.json', 'package-lock.json']},
            'dispatchScriptUrl': f.SCRIPT_URL}
    r.save('manifest.json', data)
    r.current(data)
    r.save('validation-passed.json', {'passed': True, 'candidateTreeHash': data['candidateTreeHash'],
        'evidence': str(ARTIFACT / 'results/refresh-targets-evidence.json'), 'checks': evidence})
    print(json.dumps({'prepared': True, 'files': FILES, 'candidateTreeHash': data['candidateTreeHash']}), flush=True)


if __name__ == '__main__':
    if sys.argv[1] in ['build', 'apply', 'verify']:
        atexit.register(r.cleanup_manual)
    {'prepare': prepare, 'build': r.build, 'apply': f.apply, 'verify': f.verify}[sys.argv[1]]()
