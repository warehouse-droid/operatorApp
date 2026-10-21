"""Release only the verified Special operation and SO closure changes."""
import importlib.util
import json
from pathlib import Path
import sys

spec = importlib.util.spec_from_file_location('adjustments', Path(__file__).with_name('special-workflow-adjustments-deploy.py'))
deployment = importlib.util.module_from_spec(spec)
spec.loader.exec_module(deployment)
release = deployment.release
release.BASE_IMAGE = 'sha256:570e0c985caeb905f7c51a65f7962618b28060136b8c7c224a533ca379991688'
deployment.WORKER_BASE = release.BASE_IMAGE
release.RELEASE = release.SERVER / 'test-artifacts/special-operation-progress-release-20260926'
release.EVIDENCE = release.SERVER / 'test-artifacts/special-operation-progress'
release.FILES = json.loads((release.EVIDENCE / 'runtime-files.json').read_text())
release.IMAGE = 'mbbs-operator-app:special-operation-progress-20260926'
release.ROLLBACK = 'mbbs-operator-app:rollback-special-operation-progress-20260926'
release.migrate = lambda _info: None

if __name__ == '__main__':
    {'prepare': deployment.prepare, 'apply': deployment.apply, 'verify': release.verify}[sys.argv[1]]()
