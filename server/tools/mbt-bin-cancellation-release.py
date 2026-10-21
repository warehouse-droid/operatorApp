"""Release the audited cancellation total and active-bin display over the previous BIN fixes."""
import importlib.util
import json
from pathlib import Path
import shutil
import sys

spec = importlib.util.spec_from_file_location('bin_corrections_release', Path(__file__).with_name('mbt-bin-corrections-release.py'))
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)
release.RELEASE = release.SERVER / 'deployments/mbt-bin-cancellation-20261015'
release.IMAGE = 'mbbs-operator-app:mbt-bin-cancellation-20261015'
release.TEST_IMAGE = 'mbbs-operator-app:mbt-bin-cancellation-browser-test-20261015'
release.BASE_IMAGE = 'mbbs-operator-app:mbt-bin-cancellation-rollback-20261015'
release.OLD = ['public/mbt-frontdesk.js', 'src/mbt/customer-charge-request-service.js']
release.NEW = []

if sys.argv[1] == 'prepare':
    archive = release.OUT / 'initial-release'
    if not archive.exists():
        archive.mkdir()
        for filename in ['prepared.json', 'deployment.json', 'live-verification.json', 'production.patch',
                         'validation.all.json', 'validation.candidate.json', 'evidence.json']:
            source = release.OUT / filename
            if source.exists():
                shutil.copyfile(source, archive / filename)
    release.prepare()
elif sys.argv[1] == 'deploy':
    assert json.loads((release.OUT / 'validation.candidate.json').read_text())['fullGauntlet']
    release.deploy()
else:
    release.verify()
