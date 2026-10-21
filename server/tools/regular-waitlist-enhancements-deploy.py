"""Scoped enhancement release over the deployed regular waitlist app."""
import importlib.util
import json
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
RELEASE = ROOT / 'deployments/regular-waitlist-enhancements-20261002'
OUT = ROOT / 'test-artifacts/regular-waitlist-enhancements-20261002'
FILES = json.loads((ROOT / 'tools/regular-waitlist-enhancements-files.json').read_text())
IMAGE = 'mbbs-operator-app:regular-waitlist-enhancements-20261002'
spec = importlib.util.spec_from_file_location('waitlist_enhancement_release', ROOT / 'tools/regular-waitlist-deploy.py')
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)
for module in [release, release.core, release.core.parent]:
    module.RELEASE, module.OUT, module.FILES, module.IMAGE = RELEASE, OUT, FILES, IMAGE
release.core.parent.core.RELEASE = RELEASE


def apply():
    count=release.core.parent.database("SELECT count(*) FROM regular_waitlist_conversions WHERE status IN ('pending','preparing','submitted','uncertain')")
    assert count=='0', 'Wait for active waitlist conversions before switching the app: '+count
    release.apply()


if __name__=='__main__':
    {'capture':release.capture,'stage':release.stage,'prepare':release.core.prepare,'apply':apply,'verify':release.verify}[sys.argv[1]]()
