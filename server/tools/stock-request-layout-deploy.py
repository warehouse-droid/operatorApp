"""Deploy only the reviewed stock request filters and detail layout."""
import importlib.util
import json
from pathlib import Path
import sys

spec=importlib.util.spec_from_file_location('adjustments',Path(__file__).with_name('special-workflow-adjustments-deploy.py'))
deployment=importlib.util.module_from_spec(spec)
spec.loader.exec_module(deployment)
release=deployment.release
release.BASE_IMAGE='sha256:44e14da16b5eff8a60c97b0f513bbae3caf9712c9aea59f23e6b6634c0357825'
deployment.WORKER_BASE=release.BASE_IMAGE
release.RELEASE=release.SERVER/'test-artifacts/stock-request-layout-release-20260927'
release.EVIDENCE=release.SERVER/'test-artifacts/stock-request-cleanup-layout'
release.FILES=json.loads((release.EVIDENCE/'runtime-files.json').read_text())
release.IMAGE='mbbs-operator-app:stock-request-layout-20260927'
release.ROLLBACK='mbbs-operator-app:rollback-stock-request-layout-20260927'
release.migrate=lambda _info:None

if __name__=='__main__':
    {'prepare':deployment.prepare,'apply':deployment.apply,'verify':release.verify}[sys.argv[1]]()
