"""Release the top-right Aggregate yard selector and restored eighth card."""
import importlib.util
import os
from pathlib import Path
import sys

SERVER = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('aggregate_header_release', SERVER / 'tools/aggregate-terminology-layout-deploy.py')
base = importlib.util.module_from_spec(spec)
spec.loader.exec_module(base)
FILES = sorted(['public/aggregate-requester.js', 'public/aggregate-requests.css',
    'public/aggregate-requests.html', 'public/scm-stock-requests.html'])
for module in [base, base.previous, base.access, base.release, base.core]:
    for key, value in {
        'RELEASE': SERVER / 'test-artifacts/aggregate-yard-header-deployment-20260923',
        'CHECKS': SERVER / 'test-artifacts/aggregate-yard-header',
        'VERSION': '20260923-aggregate-yard-header-v1',
        'IMAGE': 'mbbs-operator-app:aggregate-yard-header-20260923-v1',
        'ROLLBACK': 'mbbs-operator-app:rollback-aggregate-yard-header-20260923-v1',
        'FILES': FILES, 'EXISTING': FILES, 'ADDED': []
    }.items():
        setattr(module, key, value)
base.core.BEFORE = base.CHECKS / 'before'
base.VERIFIED = FILES + base.TESTS + [name for name in base.VERIFIED if name.startswith('tools/')] + ['tools/aggregate-yard-header-deploy.py']
original_checks = base.checks_passed


def checks_passed():
    original_checks()
    rows = base.json.loads((base.CHECKS / 'dimensions.json').read_text())
    for row in rows:
        assert len(row['cards']) == 7 and row['cardCount'] == 8
        assert row['yardIsLast'] and not row['selectorInCard'] and not row['accessHintVisible']
        assert row['selector']['bottom'] < row['grid']['y']
        assert abs(row['selector']['right'] - row['form']['right']) < 1
        if row['width'] > 1050:
            cards = row['cards'] + [row['yard']]
            assert max(card['height'] for card in cards) - min(card['height'] for card in cards) < 1
            assert abs(row['yard']['y'] - cards[4]['y']) < 1
            assert abs(row['yard']['x'] - cards[3]['x']) < 1


base.checks_passed = checks_passed
if __name__ == '__main__':
    os.umask(0o077)
    {'record': base.record, 'prepare': base.access.prepare, 'build': base.release.build,
     'check': base.previous.check, 'apply': base.release.apply, 'verify': base.previous.verify}[sys.argv[1]]()
