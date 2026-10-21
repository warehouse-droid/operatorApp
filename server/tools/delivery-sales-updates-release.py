"""Validate and release the delivery SO linkage, planning windows and persistent alerts."""
import atexit
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys

SERVER = Path(__file__).resolve().parents[1]
ARTIFACT = SERVER / 'test-artifacts/delivery-sales-updates-20261008'
RELEASE = SERVER / 'deployments/delivery-sales-updates-20261008'
spec = importlib.util.spec_from_file_location('delivery_ui_release', SERVER / 'tools/delivery-request-ui-release.py')
ui = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ui)
ui.ARTIFACT = ARTIFACT
ui.RELEASE = RELEASE
release = ui.release
release.RELEASE = RELEASE
release.IMAGE = 'mbbs-operator-app:delivery-sales-updates-20261008'
release.ROLLBACK = release.IMAGE + '-rollback'
release.READ_NAME = 'mbbs-delivery-sales-baseline-reader'
release.CHECK_NAME = 'mbbs-delivery-sales-image-check'
PO_ARTIFACT = SERVER / 'test-artifacts/special-po-sales-alert-20261008'
DELIVERY_RELEASE = SERVER / 'deployments/delivery-so-linkage-20261008'
DELIVERY_FILES = json.loads((DELIVERY_RELEASE / 'manifest.json').read_text())['files']
PO_FILES = list(json.loads((PO_ARTIFACT / 'before-hashes.json').read_text()))


def capture():
    ARTIFACT.mkdir(parents=True, exist_ok=True)
    previous = json.loads((DELIVERY_RELEASE / 'manifest.json').read_text())
    baseline = {name: previous['beforeTree'][name] for name in DELIVERY_FILES}
    baseline.update(json.loads((PO_ARTIFACT / 'before-hashes.json').read_text()))
    (ARTIFACT / 'before.json').write_text(json.dumps(baseline, indent=2) + '\n')
    ui.capture()


def validate():
    import difflib
    import hashlib
    data = release.state()
    release.current(data)
    for group, files, command in [('delivery', DELIVERY_FILES, 'tools/delivery-linkage-checks.mjs'),
                                  ('po-sales', PO_FILES, 'tools/special-po-sales-checks.mjs')]:
        artifact = ARTIFACT / group
        results = artifact / 'results'
        results.mkdir(parents=True, exist_ok=True)
        changed = {}
        patches = []
        for name in files:
            before = (RELEASE / 'before' / name).read_text().splitlines(keepends=True)
            source = (RELEASE / 'candidate' / name).read_bytes()
            after = source.decode().splitlines(keepends=True)
            lines = []
            for tag, _a, _b, start, end in difflib.SequenceMatcher(a=before, b=after, autojunk=False).get_opcodes():
                if tag in ('insert', 'replace'):
                    lines.extend(range(start+1, end+1))
            changed[name] = {'lines': lines, 'sourceHash': hashlib.sha256(source).hexdigest()}
            patches.extend(difflib.unified_diff(before, after, fromfile='live/'+name, tofile='candidate/'+name))
        (results / 'changed-lines-input.json').write_text(json.dumps(changed, indent=2)+'\n')
        (artifact / 'changes.patch').write_text(''.join(patches))
        env = {**os.environ, 'DELIVERY_UPDATES_SOURCE_ROOT': str(RELEASE / 'candidate'),
               'DELIVERY_UPDATES_ARTIFACT_ROOT': str(artifact),
               'DELIVERY_UPDATES_PROJECT': 'mbbs-delivery-sales-' + group + '-test'}
        with (RELEASE / (group+'-validation.log')).open('wb') as output:
            result = subprocess.run(['bash', str(SERVER / 'tools/delivery-request-updates-test.sh'),
                                     'node', command], cwd=SERVER.parent, env=env,
                                    stdout=output, stderr=subprocess.STDOUT)
        assert result.returncode == 0, group+' candidate tests failed'
        release.current(data)
    release.save('validation-passed.json', {'passed': True, 'candidateTreeHash': data['candidateTreeHash'], 'at': release.now()})
    print(json.dumps({'validated': True, 'candidateTreeHash': data['candidateTreeHash']}), flush=True)


if __name__ == '__main__':
    atexit.register(release.cleanup_manual)
    {'capture': capture, 'refresh-candidate': ui.refresh_candidate, 'validate': validate,
     'build': release.build, 'apply': ui.apply, 'verify': ui.verify}[sys.argv[1]]()
