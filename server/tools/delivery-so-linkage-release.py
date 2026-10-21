"""Validate and release the delivery SO linkage, planning windows and persistent alerts."""
import atexit
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys

SERVER = Path(__file__).resolve().parents[1]
ARTIFACT = SERVER / 'test-artifacts/delivery-so-linkage-20261008'
RELEASE = SERVER / 'deployments/delivery-so-linkage-20261008'
spec = importlib.util.spec_from_file_location('delivery_ui_release', SERVER / 'tools/delivery-request-ui-release.py')
ui = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ui)
ui.ARTIFACT = ARTIFACT
ui.RELEASE = RELEASE
release = ui.release
release.RELEASE = RELEASE
release.IMAGE = 'mbbs-operator-app:delivery-so-linkage-20261008'
release.ROLLBACK = release.IMAGE + '-rollback'
release.READ_NAME = 'mbbs-delivery-linkage-baseline-reader'
release.CHECK_NAME = 'mbbs-delivery-linkage-image-check'
FILES = list(json.loads((ARTIFACT / 'before-hashes.json').read_text()))


def capture():
    baseline = json.loads((ARTIFACT / 'before-hashes.json').read_text())
    frontend = json.loads((SERVER / 'test-artifacts/delivery-timeslot-frontend-20261008/before-hashes.json').read_text())
    for name in ['public/delivery-requests.js', 'public/delivery-requests.css', 'public/delivery-requests.html']:
        baseline[name] = frontend[name]
    (ARTIFACT / 'before.json').write_text(json.dumps({name: baseline[name] for name in FILES}, indent=2) + '\n')
    ui.capture()


def validate():
    data = release.state()
    release.current(data)
    subprocess.run([sys.executable, str(SERVER / 'tools/delivery-linkage-diff.py')], check=True)
    command = ['node', 'tools/delivery-linkage-checks.mjs']
    env = {**os.environ, 'DELIVERY_UPDATES_SOURCE_ROOT': str(RELEASE / 'candidate'),
           'DELIVERY_UPDATES_ARTIFACT_ROOT': str(ARTIFACT / 'final'),
           'DELIVERY_UPDATES_PROJECT': 'mbbs-delivery-linkage-final'}
    with (RELEASE / 'validation.log').open('wb') as output:
        result = subprocess.run(['bash', str(SERVER / 'tools/delivery-request-updates-test.sh'), *command],
                                cwd=SERVER.parent, env=env, stdout=output, stderr=subprocess.STDOUT)
    assert result.returncode == 0, 'Candidate tests failed; see validation.log'
    release.current(data)
    release.save('validation-passed.json', {'passed': True, 'at': release.now(),
        'candidateTreeHash': data['candidateTreeHash'], 'command': command})
    print(json.dumps({'validated': True, 'candidateTreeHash': data['candidateTreeHash']}), flush=True)


if __name__ == '__main__':
    atexit.register(release.cleanup_manual)
    {'capture': capture, 'refresh-candidate': ui.refresh_candidate, 'validate': validate,
     'build': release.build, 'apply': ui.apply, 'verify': ui.verify}[sys.argv[1]]()
