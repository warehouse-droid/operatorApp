"""Use the captured-image release workflow for the single PO history search patch."""
import importlib.util
import json
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[3]
spec = importlib.util.spec_from_file_location('app_release', ROOT / 'server/tools/stock-request-apply-20261010/release.py')
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)
release.ART = ROOT / 'server/test-artifacts/movement-po-search-20261010'
release.STATE = Path('/home/ubuntu/operatorapp-deploy-backups/movement-po-search-20261010')
release.core.STATE = release.STATE
release.FILES = json.loads((release.ART / 'files.json').read_text())
release.TAG = 'mbbs-operator-app:movement-po-search-20261010'
release.BASE = release.TAG + '-rollback'
release.CHECK_MODES = ['repository']

if __name__ == '__main__':
    {'capture': release.capture, 'prepare': release.prepare, 'build': release.build, 'deploy': release.deploy, 'verify': release.verify}[sys.argv[1]]()
