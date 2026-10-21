"""Release only the verified Special operation and SO closure changes."""
import importlib.util
import json
from pathlib import Path
import sys

spec = importlib.util.spec_from_file_location('adjustments', Path(__file__).with_name('special-workflow-adjustments-deploy.py'))
deployment = importlib.util.module_from_spec(spec)
spec.loader.exec_module(deployment)
release = deployment.release
release.BASE_IMAGE = 'sha256:de3178653d8231024557dbdba394d867a49969220434089dea575966b43ba638'
deployment.WORKER_BASE = release.BASE_IMAGE
release.RELEASE = release.SERVER / 'test-artifacts/special-closed-discount-release-20260926'
release.EVIDENCE = release.SERVER / 'test-artifacts/special-closed-discount'
release.FILES = json.loads((release.EVIDENCE / 'runtime-files.json').read_text())
release.IMAGE = 'mbbs-operator-app:special-closed-discount-20260926'
release.ROLLBACK = 'mbbs-operator-app:rollback-special-closed-discount-20260926'
release.migrate = lambda _info: None

if __name__ == '__main__':
    {'prepare': deployment.prepare, 'apply': deployment.apply, 'verify': release.verify}[sys.argv[1]]()
