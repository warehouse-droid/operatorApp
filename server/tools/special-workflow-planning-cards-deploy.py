"""Publish only the responsive SO/PO planning-card stylesheet."""
import importlib.util
import json
from pathlib import Path
import sys

spec = importlib.util.spec_from_file_location('layout', Path(__file__).with_name('special-workflow-sales-layout-deploy.py'))
layout = importlib.util.module_from_spec(spec)
spec.loader.exec_module(layout)
release = layout.release
release.BASE_IMAGE = 'sha256:536b78a662e9f7f5a8f53f88d8d993f976ef1cb83845c42c3ff55f6d6874112d'
release.RELEASE = release.SERVER / 'test-artifacts/special-workflow-planning-cards-release-20260926'
release.EVIDENCE = release.SERVER / 'test-artifacts/special-workflow-review/planning-cards'
release.FILES = ['public/special-stock-documents.css']
release.IMAGE = 'mbbs-operator-app:special-planning-cards-20260926'
release.ROLLBACK = 'mbbs-operator-app:rollback-special-planning-cards-20260926'


def evidence():
    checks = json.loads((release.EVIDENCE / 'ui-smoke.json').read_text())
    assert len(checks) == 3 and all(row['passed'] for row in checks)
    hashes = json.loads((release.EVIDENCE / 'source-manifest.json').read_text())
    for file in release.FILES:
        assert release.core.digest((release.SERVER / file).read_bytes()) == hashes[file]
    return hashes


layout.evidence = evidence
release.evidence = evidence
if __name__ == '__main__':
    {'prepare': layout.prepare, 'apply': release.apply, 'verify': release.verify}[sys.argv[1]]()
