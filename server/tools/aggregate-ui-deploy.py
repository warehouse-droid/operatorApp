"""Release the translated Aggregate cards and Operator Inventory navigation."""
import importlib.util
import io
import json
import os
from pathlib import Path
import re
import sys
import tarfile

SERVER = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('aggregate_ui_release', SERVER / 'tools/aggregate-deploy.py')
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)
core = release.core
CHECKS = SERVER / 'test-artifacts/aggregate-ui'
VERSION = '20260922-aggregate-ui-v2'
EXISTING = ['public/aggregate-requests.html', 'public/aggregate-requests.css', 'public/aggregate-requests.js',
            'public/operator.js', 'public/operator.html', 'public/service-worker.js', 'public/i18n.js',
            'public/scm-stock-requests.html', 'public/scm-stock-request-tabs.js']
ADDED = ['public/aggregate-requests-i18n.js']
FILES = sorted(EXISTING + ADDED)
for key, value in {
    'RELEASE': SERVER / 'test-artifacts/aggregate-ui-deployment-20260922',
    'IMAGE': 'mbbs-operator-app:aggregate-ui-20260922-v2',
    'ROLLBACK': 'mbbs-operator-app:rollback-aggregate-ui-20260922-v2',
    'VERSION': VERSION, 'EXISTING': EXISTING, 'ADDED': ADDED, 'FILES': FILES
}.items():
    setattr(release, key, value)
    setattr(core, key, value)
core.BEFORE = CHECKS / 'baseline'

# Extract container copies as the current workspace user. The existing image has
# private, node-owned overlay directories; docker cp to a host path preserves
# their restrictive permissions while creating root-owned directories.
original_docker = core.docker


def workspace_docker(*args, **kwargs):
    if args[0] != 'cp':
        return original_docker(*args, **kwargs)
    assert len(args) == 3
    target = Path(args[2])
    assert target.resolve().is_relative_to(release.RELEASE.resolve())
    archive_bytes = original_docker('cp', args[1], '-', **kwargs)
    with tarfile.open(fileobj=io.BytesIO(archive_bytes)) as archive:
        assert all(Path(member.name).parts[0] == target.name for member in archive.getmembers())
        archive.extractall(target.parent, filter='data')
    return b''


core.docker = workspace_docker


def checks_gate():
    assert '# pass 39\n# fail 0' in (CHECKS / 'tests.log').read_text()
    for name in ['neighbors.log', 'navigation.log']:
        assert '# fail 0\n' in (CHECKS / name).read_text(), name
    assert 'Syntax, lint and domain type checks passed.' in (CHECKS / 'static.log').read_text()
    original = json.loads((SERVER / 'test-artifacts/aggregate-validation/aggregate-source.json').read_text())
    for name in ['src/aggregate-request-domain.js', 'src/aggregate-request-repository.js',
                 'src/aggregate-request-router.js', 'migrations/215_aggregate_requests.sql']:
        assert core.digest((SERVER / name).read_bytes()) == original['files'][name], 'Backend changed: ' + name


def seal():
    checks_gate()
    tests = ['test/mbt/unit/aggregate-request-domain.test.js', 'test/mbt/integration/aggregate-request-repository.test.js',
             'test/mbt/integration/aggregate-request-http.test.js', 'test/mbt/integration/aggregate-request-browser.test.js',
             'test/mbt/unit/operator-delivery-refresh.test.js', 'test/mbt/unit/operator-ui-enhancements.test.js',
             'test/mbt/unit/operations-navigation-enhancements.test.js']
    tooling = ['tools/aggregate-checks.mjs', 'tools/aggregate-eslint.config.mjs', 'tools/aggregate-test-env.sh',
               'tools/aggregate-ui-deploy.py', 'tools/aggregate-deploy.py', 'tools/operator-display-settings-deploy.py',
               'tools/aggregate-live.mjs']
    hashes = {name: core.digest((SERVER / name).read_bytes()) for name in sorted(FILES + tests + tooling)}
    state = {'files': hashes, 'sourceHash': core.digest(json.dumps(hashes, sort_keys=True).encode())}
    (CHECKS / 'source.json').write_text(json.dumps(state, indent=2) + '\n')
    print(json.dumps({'verifiedSource': state['sourceHash'], 'runtimeFiles': len(FILES)}), flush=True)


def source_gate():
    checks_gate()
    state = json.loads((CHECKS / 'source.json').read_text())
    for name, sha in state['files'].items():
        assert core.digest((SERVER / name).read_bytes()) == sha, 'Verified UI source changed: ' + name
    return state['sourceHash']


def shell_assets(file, text):
    for asset in ['i18n.js', 'operator-delivery-refresh.js', 'operator.js']:
        text, count = re.subn(r'/' + re.escape(asset) + r'\?v=[^"\s]+', '/' + asset + '?v=' + VERSION, text)
        assert count == 1, asset
    if file.endswith('service-worker.js'):
        text, count = re.subn(r'const CACHE_NAME = "[^"]+";',
                             'const CACHE_NAME = "mbbs-yard-operator-' + VERSION + '";', text)
        assert count == 1
    return text


def existing_schema():
    assert core.database("SELECT count(*) FROM schema_migrations WHERE filename='215_aggregate_requests.sql';").strip() == '1'
    core.save('schema-check.json', {'migration215AlreadyApplied': True, 'databaseChanges': False})


release.source_gate = source_gate
release.backup_and_migrate = existing_schema
core.shell_assets = shell_assets

if __name__ == '__main__':
    os.umask(0o077)
    commands = {'seal': seal, **{name: getattr(release, name) for name in ['prepare', 'build', 'check', 'apply', 'verify']}}
    commands[sys.argv[1]]()
