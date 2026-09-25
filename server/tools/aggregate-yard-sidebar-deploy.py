"""Release the Aggregate yard sidebar using the existing UI release workflow."""
import importlib.util
import os
from pathlib import Path
import sys

SERVER = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('aggregate_sidebar_release', SERVER / 'tools/aggregate-terminology-layout-deploy.py')
base = importlib.util.module_from_spec(spec)
spec.loader.exec_module(base)
FILES = sorted(['public/aggregate-requester.js', 'public/aggregate-requests.css',
    'public/aggregate-requests.html', 'public/scm-stock-requests.html'])
for module in [base, base.previous, base.access, base.release, base.core]:
    for key, value in {
        'RELEASE': SERVER / 'test-artifacts/aggregate-yard-sidebar-deployment-20260923',
        'CHECKS': SERVER / 'test-artifacts/aggregate-yard-sidebar',
        'VERSION': '20260923-aggregate-yard-sidebar-v1',
        'IMAGE': 'mbbs-operator-app:aggregate-yard-sidebar-20260923-v1',
        'ROLLBACK': 'mbbs-operator-app:rollback-aggregate-yard-sidebar-20260923-v1',
        'FILES': FILES, 'EXISTING': FILES, 'ADDED': []
    }.items():
        setattr(module, key, value)
base.core.BEFORE = base.CHECKS / 'before'
base.VERIFIED = FILES + base.TESTS + [name for name in base.VERIFIED if name.startswith('tools/')] + ['tools/aggregate-yard-sidebar-deploy.py']
original_checks = base.checks_passed


def checks_passed():
    original_checks()
    rows = base.json.loads((base.CHECKS / 'dimensions.json').read_text())
    for row in rows:
        assert len(row['cards']) == 7
        assert max(card['height'] for card in row['cards']) - min(card['height'] for card in row['cards']) < 1
        if row['width'] > 900:
            assert row['yard']['x'] > row['grid']['right']
            assert abs(row['yard']['y'] - row['grid']['y']) < 1
        else:
            assert row['yard']['y'] > row['grid']['bottom']


base.checks_passed = checks_passed
if __name__ == '__main__':
    os.umask(0o077)
    {'record': base.record, 'prepare': base.access.prepare, 'build': base.release.build,
     'check': base.previous.check, 'apply': base.release.apply, 'verify': base.previous.verify}[sys.argv[1]]()
