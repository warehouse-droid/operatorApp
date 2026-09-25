"""Release Aggregate Chinese terminology and Operator-sized viewport styles."""
import importlib.util
import json
import os
from pathlib import Path
import re
import sys

SERVER = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('aggregate_terminology_release', SERVER / 'tools/aggregate-actuals-deploy.py')
previous = importlib.util.module_from_spec(spec)
spec.loader.exec_module(previous)
access, release, core = previous.access, previous.release, previous.core
CHECKS = SERVER / 'test-artifacts/aggregate-terminology-layout'
VERSION = '20260923-aggregate-terminology-layout-v1'
FILES = sorted(['public/aggregate-requests-i18n.js', 'public/aggregate-requests.css',
    'public/aggregate-requests.html', 'public/i18n.js', 'public/operator.html',
    'public/service-worker.js', 'public/scm-stock-requests.html'])
TESTS = ['test/mbt/integration/aggregate-request-browser.test.js',
    'test/mbt/unit/operator-yard-assets.test.js', 'test/mbt/unit/driver-pwa-recovery-assets.test.js']
VERIFIED = FILES + TESTS + ['tools/aggregate-terminology-layout-deploy.py',
    'tools/aggregate-actuals-deploy.py', 'tools/aggregate-access-deploy.py',
    'tools/aggregate-deploy.py', 'tools/operator-display-settings-deploy.py',
    'tools/aggregate-test-env.sh', 'tools/aggregate-checks.mjs', 'tools/aggregate-access-live.mjs']
for module in [previous, access, release, core]:
    for key, value in {
        'RELEASE': SERVER / 'test-artifacts/aggregate-terminology-layout-deployment-20260923',
        'CHECKS': CHECKS, 'VERSION': VERSION,
        'IMAGE': 'mbbs-operator-app:aggregate-terminology-layout-20260923-v1',
        'ROLLBACK': 'mbbs-operator-app:rollback-aggregate-terminology-layout-20260923-v1',
        'FILES': FILES, 'EXISTING': FILES, 'ADDED': [], 'TESTS': TESTS
    }.items():
        setattr(module, key, value)
core.BEFORE = CHECKS / 'before'


def hashes():
    return {name: core.digest((SERVER / name).read_bytes()) for name in VERIFIED}


def checks_passed():
    log = (CHECKS / 'browser-tests.log').read_text()
    assert '# pass 16\n# fail 0\n' in log
    assert 'Syntax, lint and domain type checks passed.' in (CHECKS / 'static.log').read_text()
    rows = json.loads((CHECKS / 'dimensions.json').read_text())
    assert len(rows) == 24
    for row in rows:
        assert row['operator'] == row['shell']
        assert row['documentWidth'] <= row['screenWidth']
        assert row['contentScrollWidth'] <= row['contentWidth']
        assert row['headerTopAfterScroll'] == 0
        assert row['submitBottom'] <= row['height']
        if row['language'] == 'zh-CN':
            assert (row['title'], row['gravel'], row['crusher']) == ('砂石料申请', '石子', '混合石粉')


def record():
    checks_passed()
    files = hashes()
    result = {'files': files, 'sourceHash': core.digest(json.dumps(files, sort_keys=True).encode())}
    (CHECKS / 'verified-sources.json').write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps({'verified': True, 'sourceHash': result['sourceHash']}), flush=True)


def source_gate(require_full=False):
    checks_passed()
    verified = json.loads((CHECKS / 'verified-sources.json').read_text())
    assert hashes() == verified['files'], 'Verified UI source changed'
    return verified['sourceHash']


def shell_assets(file, text):
    text, count = re.subn(r'/i18n\.js\?v=[^"\s]+', '/i18n.js?v=' + VERSION, text)
    assert count == 1
    if file.endswith('service-worker.js'):
        text, count = re.subn(r'const CACHE_NAME = "[^"]+";',
            'const CACHE_NAME = "mbbs-yard-operator-' + VERSION + '";', text)
        assert count == 1
    return text


def no_migration():
    core.save('migration-check.json', {'required': False, 'operationalDataChanged': False})


for module in [previous, access, release]:
    module.source_gate = source_gate
access.shell_assets = shell_assets
core.shell_assets = shell_assets
release.backup_and_migrate = no_migration
release.verify = previous.verify
if __name__ == '__main__':
    os.umask(0o077)
    {'record': record, 'prepare': access.prepare, 'build': release.build,
     'check': previous.check, 'apply': release.apply, 'verify': previous.verify}[sys.argv[1]]()
