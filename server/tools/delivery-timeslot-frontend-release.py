"""Validate and release the delivery timeslot text fields and immediate blocking."""
import atexit
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys

SERVER = Path(__file__).resolve().parents[1]
ARTIFACT = SERVER / 'test-artifacts/delivery-timeslot-frontend-20261008'
RELEASE = SERVER / 'deployments/delivery-timeslot-frontend-20261008'
spec = importlib.util.spec_from_file_location('delivery_ui_release', SERVER / 'tools/delivery-request-ui-release.py')
ui = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ui)
ui.ARTIFACT = ARTIFACT
ui.RELEASE = RELEASE
release = ui.release
release.RELEASE = RELEASE
release.IMAGE = 'mbbs-operator-app:delivery-timeslot-frontend-20261008'
release.ROLLBACK = release.IMAGE + '-rollback'
release.READ_NAME = 'mbbs-delivery-timeslot-baseline-reader'
release.CHECK_NAME = 'mbbs-delivery-timeslot-image-check'
FILES = ['public/delivery-requests.js', 'public/delivery-requests.css', 'public/delivery-requests.html']


def capture():
    baseline = json.loads((ARTIFACT / 'before-hashes.json').read_text())
    (ARTIFACT / 'before.json').write_text(json.dumps({name: baseline[name] for name in FILES}, indent=2) + '\n')
    ui.capture()


def validate():
    data = release.state()
    release.current(data)
    command = ['sh', '-c', 'node node_modules/.bin/eslint --config tools/delivery-request-eslint.config.mjs '
               '--max-warnings=0 public/delivery-requests.js test/mbt/integration/delivery-requests-browser.test.js '
               '&& node --check public/delivery-requests.js && node --test --test-concurrency=1 '
               'test/mbt/integration/delivery-requests-browser.test.js '
               'test/mbt/integration/delivery-request-event-stream-browser.test.js']
    env = {**os.environ, 'DELIVERY_UPDATES_SOURCE_ROOT': str(RELEASE / 'candidate'),
           'DELIVERY_UPDATES_ARTIFACT_ROOT': str(ARTIFACT), 'DELIVERY_UPDATES_SKIP_DB': '1',
           'DELIVERY_UPDATES_PROJECT': 'mbbs-delivery-timeslot-frontend-test'}
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
