"""Deploy only the verified closed-order recovery and SCM closure alerts."""
import importlib.util
import json
from pathlib import Path
import sys

spec = importlib.util.spec_from_file_location('adjustments', Path(__file__).with_name('special-workflow-adjustments-deploy.py'))
deployment = importlib.util.module_from_spec(spec)
spec.loader.exec_module(deployment)
release = deployment.release
release.BASE_IMAGE = 'sha256:672c3a331776f57413bf13eeb8652b98c163596b4ad483ef9389abf763d6c8f6'
deployment.WORKER_BASE = release.BASE_IMAGE
release.RELEASE = release.SERVER / 'test-artifacts/special-workflow-closure-lock-release-20260926'
release.EVIDENCE = release.SERVER / 'test-artifacts/special-workflow-review/closure-lock'
release.FILES = json.loads((release.EVIDENCE / 'runtime-files.json').read_text())
release.IMAGE = 'mbbs-operator-app:special-closure-lock-20260926'
release.ROLLBACK = 'mbbs-operator-app:rollback-special-closure-lock-20260926'
release.migrate = lambda _info: None  # No schema change.
if __name__ == '__main__':
    {'prepare': deployment.prepare, 'apply': deployment.apply, 'verify': release.verify}[sys.argv[1]]()
