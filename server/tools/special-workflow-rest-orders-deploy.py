"""Deploy only the verified REST amount-discount correction."""
import importlib.util
import json
from pathlib import Path
import sys

spec = importlib.util.spec_from_file_location('adjustments', Path(__file__).with_name('special-workflow-adjustments-deploy.py'))
deployment = importlib.util.module_from_spec(spec)
spec.loader.exec_module(deployment)
release = deployment.release
release.BASE_IMAGE = 'sha256:cf5b4e7e202544c489e750c18fcd6be4e1e47d9758b9fe6ca1e89e2376effb07'
deployment.WORKER_BASE = release.BASE_IMAGE
release.RELEASE = release.SERVER / 'test-artifacts/special-workflow-rest-orders-release-20260926'
release.EVIDENCE = release.SERVER / 'test-artifacts/special-workflow-review/rest-orders'
release.FILES = json.loads((release.EVIDENCE / 'runtime-files.json').read_text())
release.IMAGE = 'mbbs-operator-app:special-rest-orders-20260926'
release.ROLLBACK = 'mbbs-operator-app:rollback-special-rest-orders-20260926'
release.migrate = lambda _info: None  # No schema change.
if __name__ == '__main__':
    {'prepare': deployment.prepare, 'apply': deployment.apply, 'verify': release.verify}[sys.argv[1]]()
