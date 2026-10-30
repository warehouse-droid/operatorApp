"""Release the general same-location travel display correction with rollback."""
import importlib.util
import json
from pathlib import Path
import sys

SERVER = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('travel_release', SERVER / 'tools/dispatch-start-travel-release.py')
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)
release.RELEASE = SERVER / 'deployments/dispatch-travel-pairs-20261022'
release.core.RELEASE = release.RELEASE
release.IMAGE = 'mbbs-operator-app:dispatch-travel-pairs-20261022'
release.ROLLBACK = release.IMAGE + '-rollback'


def checked():
    data = release.core.state()
    evidence = json.loads((SERVER / 'test/dispatch/specs/dispatch-travel-pairs-20261022-evidence.json').read_text())
    assert evidence['passed'] and evidence['newFailures'] == 0
    assert evidence['sourceHashes'] == data['candidateHashes'] == release.hashes(SERVER) == release.hashes(release.RELEASE / 'candidate')
    return data


release.checked = checked

if __name__ == '__main__':
    command = sys.argv[1]
    if command == 'capture':
        release.capture()
        data = release.core.state()
        data['authorization'] = ('User authorized deploying the fix, then requested a general correction '
            'for travel between same-location stops, retaining separate drop and pickup stops.')
        release.core.save('manifest.json', data)
    else:
        {'prepare': release.prepare, 'build': release.build,
         'deploy': release.deploy, 'verify': release.verify}[command]()
