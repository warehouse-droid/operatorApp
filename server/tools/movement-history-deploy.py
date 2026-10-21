"""Release the reviewed IR/IF and driver-wait display changes only."""
import importlib.util
import json
from pathlib import Path
import sys

spec = importlib.util.spec_from_file_location('adjustments', Path(__file__).with_name('special-workflow-adjustments-deploy.py'))
deployment = importlib.util.module_from_spec(spec)
spec.loader.exec_module(deployment)
release = deployment.release
release.BASE_IMAGE = 'sha256:105450a19f63eb8f9749440a3d1f1fdedb540307a80430135bbc58618c423c22'
deployment.WORKER_BASE = release.BASE_IMAGE
release.RELEASE = release.SERVER / 'test-artifacts/movement-history-release-20260927'
release.EVIDENCE = release.SERVER / 'test-artifacts/movement-document-history'
release.FILES = json.loads((release.EVIDENCE / 'runtime-files.json').read_text())
release.IMAGE = 'mbbs-operator-app:movement-history-20260927'
release.ROLLBACK = 'mbbs-operator-app:rollback-movement-history-20260927'
release.migrate = lambda _info: None

if __name__ == '__main__':
    {'prepare': deployment.prepare, 'apply': deployment.apply, 'verify': release.verify}[sys.argv[1]]()
