"""Deploy only the verified Special queue, yard filters and tab changes."""
import importlib.util
import json
from pathlib import Path
import sys

spec = importlib.util.spec_from_file_location('adjustments', Path(__file__).with_name('special-workflow-adjustments-deploy.py'))
deployment = importlib.util.module_from_spec(spec)
spec.loader.exec_module(deployment)
release = deployment.release
release.BASE_IMAGE = 'sha256:266610ffdaa1340ff3cde119e8b5026612aa92737cdf2af642c52711cddade58'
deployment.WORKER_BASE = release.BASE_IMAGE
release.RELEASE = release.SERVER / 'test-artifacts/special-workflow-queue-access-release-20260926'
release.EVIDENCE = release.SERVER / 'test-artifacts/special-workflow-review/queue-access'
release.FILES = [file for file in json.loads((release.EVIDENCE / 'runtime-files.json').read_text()) if file != 'netsuite-smart-scm-picking-ticket-restlet.js']
release.IMAGE = 'mbbs-operator-app:special-queue-access-20260926'
release.ROLLBACK = 'mbbs-operator-app:rollback-special-queue-access-20260926'
release.migrate = lambda _info: None  # No schema change.
if __name__ == '__main__':
    {'prepare': deployment.prepare, 'apply': deployment.apply, 'verify': release.verify}[sys.argv[1]]()
