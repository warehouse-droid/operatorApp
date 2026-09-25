"""Deploy the isolated timestamp-precision correction over the arrival repair."""
import argparse
import importlib.util
import os
from pathlib import Path

SERVER = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('arrival_display_release', SERVER / 'tools/actual-arrival-repair-deploy.py')
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)
files = ['src/driver-repository.js']
for module in [release, release.release, release.core]:
    module.RELEASE = SERVER / 'test-artifacts/actual-arrival-repair/display-deployment'
    module.IMAGE = 'mbbs-operator-app:actual-arrival-20260920-v3'
    module.ROLLBACK = 'mbbs-operator-app:rollback-actual-arrival-20260920-v3'
    module.FILES = files
    module.ADDED = []
    module.EXISTING = files
release.BASELINE = SERVER / 'test-artifacts/actual-arrival-repair/display-workspace-baseline'

if __name__ == '__main__':
    os.umask(0o077)
    parser = argparse.ArgumentParser()
    parser.add_argument('action', choices=['prepare', 'refresh', 'build', 'apply', 'verify'])
    getattr(release, parser.parse_args().action)()
