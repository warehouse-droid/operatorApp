"""Release compact Aggregate cards while preserving the approved form layout."""
import importlib.util
import os
from pathlib import Path
import sys

SERVER = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('aggregate_compact_release', SERVER / 'tools/aggregate-yard-header-deploy.py')
layout = importlib.util.module_from_spec(spec)
spec.loader.exec_module(layout)
base = layout.base
FILES = sorted(['public/aggregate-requests.css', 'public/aggregate-requests.html', 'public/scm-stock-requests.html'])
for module in [layout, base, base.previous, base.access, base.release, base.core]:
    for key, value in {
        'RELEASE': SERVER / 'test-artifacts/aggregate-compact-cards-deployment-20260923',
        'CHECKS': SERVER / 'test-artifacts/aggregate-compact-cards',
        'VERSION': '20260923-aggregate-compact-cards-v1',
        'IMAGE': 'mbbs-operator-app:aggregate-compact-cards-20260923-v1',
        'ROLLBACK': 'mbbs-operator-app:rollback-aggregate-compact-cards-20260923-v1',
        'FILES': FILES, 'EXISTING': FILES, 'ADDED': []
    }.items():
        setattr(module, key, value)
base.core.BEFORE = base.CHECKS / 'before'
base.VERIFIED = FILES + base.TESTS + [name for name in base.VERIFIED if name.startswith('tools/')] + ['tools/aggregate-compact-cards-deploy.py']
original_checks = base.checks_passed


def checks_passed():
    original_checks()
    rows = base.json.loads((base.CHECKS / 'dimensions.json').read_text())
    baseline = base.json.loads((SERVER / 'test-artifacts/aggregate-yard-header/dimensions.json').read_text())
    key = lambda row: (row['language'], row['stage'], row['width'], row['height'])
    before = {key(row): row for row in baseline}
    for row in rows:
        assert all(button['width'] >= 44 and button['height'] >= 44 for button in row['buttons'])
        assert all(card['height'] < old['height'] for card, old in zip(row['cards'], before[key(row)]['cards'], strict=True))


base.checks_passed = checks_passed
if __name__ == '__main__':
    os.umask(0o077)
    {'record': base.record, 'prepare': base.access.prepare, 'build': base.release.build,
     'check': base.previous.check, 'apply': base.release.apply, 'verify': base.previous.verify}[sys.argv[1]]()
