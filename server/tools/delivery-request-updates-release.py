"""Release the six delivery-request fixes over the current live application."""
import atexit
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys

SERVER = Path(__file__).resolve().parents[1]
ARTIFACT = SERVER / 'test-artifacts/delivery-request-updates-20261008'
RELEASE = SERVER / 'deployments/delivery-request-updates-20261008'
spec = importlib.util.spec_from_file_location('delivery_ui_release', SERVER / 'tools/delivery-request-ui-release.py')
ui = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ui)
ui.ARTIFACT = ARTIFACT
ui.RELEASE = RELEASE
release = ui.release
release.RELEASE = RELEASE
release.IMAGE = 'mbbs-operator-app:delivery-request-updates-20261008'
release.ROLLBACK = release.IMAGE + '-rollback'
release.READ_NAME = 'mbbs-delivery-updates-baseline-reader'
release.CHECK_NAME = 'mbbs-delivery-updates-image-check'
FILES = ['public/delivery-request-alert.js', 'public/app-sidebar.js', 'public/delivery-requests.js',
         'public/delivery-requests.css', 'public/delivery-requests.html', 'src/delivery-request-domain.js']


def capture():
    baseline = json.loads((ARTIFACT / 'before-hashes.json').read_text())
    (ARTIFACT / 'before.json').write_text(json.dumps({name: baseline[name] for name in FILES}, indent=2) + '\n')
    ui.capture()


def validate():
    data = release.state()
    release.current(data)
    command = ['node', 'tools/delivery-request-updates-checks.mjs']
    env = {**os.environ, 'DELIVERY_UPDATES_SOURCE_ROOT': str(RELEASE / 'candidate')}
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
    {'capture': capture, 'validate': validate, 'build': release.build,
     'apply': ui.apply, 'verify': ui.verify}[sys.argv[1]]()
