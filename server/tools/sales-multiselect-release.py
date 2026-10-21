"""Release the Sales multi-select case-stage, request-type and vendor filters."""
import difflib
import importlib.util
import io
import json
import os
from pathlib import Path
import shutil
import sys
import tarfile

SERVER = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('stock_view_release', SERVER / 'tools/stock-request-view-release.py')
view = importlib.util.module_from_spec(spec)
spec.loader.exec_module(view)
r = view.release
view.RELEASE = r.RELEASE = SERVER / 'deployments/sales-multiselect-20261009'
view.ARTIFACT = SERVER / 'test-artifacts/sales-multiselect-20261009'
r.IMAGE = 'mbbs-operator-app:sales-multiselect-20261009'
r.ROLLBACK = r.IMAGE + '-rollback'
r.READ_NAME = 'mbbs-sales-multiselect-baseline-reader'
r.CHECK_NAME = 'mbbs-sales-multiselect-image-check'
NEW_FILES = ['public/sales-stock-list-filters.js']
base_http_check = view.http_check
view.http_check = lambda data: base_http_check({**data, 'files':[n for n in data['files'] if n.startswith('public/')]})


def capture():
    os.umask(0o077)
    r.RELEASE.mkdir(exist_ok=False)
    before = r.metadata(r.APP)
    dependencies = [r.metadata(n) for n in r.DEPENDENCIES]
    baseline = r.RELEASE / 'before'
    baseline.mkdir()
    archive = r.docker('exec', r.APP, 'tar', '-cf', '-', '-C', '/app',
                       'src', 'public', 'migrations', 'package.json', 'package-lock.json')
    with tarfile.open(fileobj=io.BytesIO(archive)) as stream:
        stream.extractall(baseline, filter='data')
    assert r.metadata(r.APP) == before
    candidate = r.RELEASE / 'candidate'
    shutil.copytree(baseline, candidate)
    original = json.loads((view.ARTIFACT / 'workspace-before.json').read_text())
    patch = ''
    for name, digest in original.items():
        old = view.ARTIFACT / 'workspace-before' / name
        assert r.sha(old.read_bytes()) == digest
        patch += ''.join(difflib.unified_diff(old.read_text().splitlines(True),
            (SERVER / name).read_text().splitlines(True), fromfile='a/' + name, tofile='b/' + name))
    (r.RELEASE / 'candidate.patch').write_text(patch)
    r.apply_patch(candidate, patch, 'sales-status-filter')
    for name in NEW_FILES:
        assert not (candidate / name).exists()
        shutil.copy2(SERVER / name, candidate / name)
    before_tree, after_tree = r.files_at(baseline), r.files_at(candidate)
    changed = sorted(n for n in before_tree.keys() | after_tree.keys() if before_tree.get(n) != after_tree.get(n))
    assert changed == sorted([*[n for n,digest in original.items() if r.sha((SERVER/n).read_bytes()) != digest], *NEW_FILES]), 'Unexpected release scope'
    r.save('manifest.json', {'capturedAt': r.now(), 'app': before, 'dependencies': dependencies,
        'files': changed, 'beforeTree': before_tree, 'candidateTree': after_tree,
        'candidateTreeHash': r.sha(json.dumps(after_tree, sort_keys=True).encode()),
        'workspace': {n: r.sha((SERVER / n).read_bytes()) for n in changed},
        'packages': {n: r.sha((candidate / n).read_bytes()) for n in ['package.json', 'package-lock.json']}})
    print(json.dumps({'captured': True, 'files': changed}), flush=True)


def validate():
    data = r.state()
    r.current(data)
    result = json.loads((view.ARTIFACT / 'checks/results/workflow-checks.json').read_text())
    assert result['candidateTreeHash'] == data['candidateTreeHash']
    assert result['checks'] and all(check['exit'] == 0 for check in result['checks'])
    assert 'teardown_exit=0' in (view.ARTIFACT / 'checks/teardown.log').read_text()
    r.save('validation-passed.json', {'passed': True, 'candidateTreeHash': data['candidateTreeHash'], 'checks': result['checks']})
    print(json.dumps({'validated': True}), flush=True)


def refresh():
    data = r.state()
    assert r.metadata(r.APP) == data['app']
    assert r.files_at(r.RELEASE / 'candidate') == data['candidateTree']
    original = json.loads((view.ARTIFACT / 'workspace-before.json').read_text())
    patch = ''
    for name in original:
        old = view.ARTIFACT / 'workspace-before' / name
        patch += ''.join(difflib.unified_diff(old.read_text().splitlines(True),
            (SERVER/name).read_text().splitlines(True), fromfile='a/'+name,tofile='b/'+name))
    shutil.rmtree(r.RELEASE / 'candidate')
    shutil.copytree(r.RELEASE / 'before', r.RELEASE / 'candidate')
    r.apply_patch(r.RELEASE / 'candidate', patch, 'sales-workflow-refresh')
    for name in NEW_FILES:
        shutil.copy2(SERVER/name, r.RELEASE/'candidate'/name)
    (r.RELEASE/'candidate.patch').write_text(patch)
    data['candidateTree'] = r.files_at(r.RELEASE/'candidate')
    data['files'] = sorted(n for n in data['candidateTree'].keys() | data['beforeTree'].keys() if data['candidateTree'].get(n) != data['beforeTree'].get(n))
    data['candidateTreeHash'] = r.sha(json.dumps(data['candidateTree'],sort_keys=True).encode())
    data['workspace'] = {n:r.sha((SERVER/n).read_bytes()) for n in data['files']}
    r.save('manifest.json',data)
    print(json.dumps({'refreshed':True,'files':data['files']}),flush=True)


if __name__ == '__main__':
    {'capture': capture, 'refresh': refresh, 'validate': validate, 'build': r.build, 'apply': view.apply, 'verify': view.verify}[sys.argv[1]]()
