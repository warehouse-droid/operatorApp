"""Release only this feature over the captured production runtime."""
import atexit
import difflib
import importlib.util
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tarfile

SERVER = Path(__file__).resolve().parents[1]
ROOT = SERVER.parent
RELEASE = SERVER / 'deployments/backorder-already-ordered-20261008'
spec = importlib.util.spec_from_file_location('release_helpers', SERVER / 'tools/delivery-scm-release.py')
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)
release.RELEASE = RELEASE
release.IMAGE = 'mbbs-operator-app:backorder-already-ordered-20261008'
release.ROLLBACK = release.IMAGE + '-rollback'
release.READ_NAME = 'mbbs-already-ordered-reader'
release.CHECK_NAME = 'mbbs-already-ordered-image-check'
FILES = ['public/backorder-workflow.js', 'public/backorder-stock-requests.js',
         'src/backorder-request-service.js', 'src/special-stock-request-repository.js',
         'public/sales-stock-requests.js', 'public/scm-stock-requests.js',
         'public/sales-stock-requests.html', 'public/scm-stock-requests.html']
MIGRATION = 'migrations/274_backorder_already_ordered.sql'


def capture():
    RELEASE.mkdir(parents=True, exist_ok=False)
    before = release.metadata(release.APP)
    dependencies = [release.metadata(name) for name in release.DEPENDENCIES]
    baseline = RELEASE / 'before'
    baseline.mkdir()
    archive = release.docker('exec', release.APP, 'tar', '-cf', '-', '-C', '/app',
                             'src', 'public', 'migrations', 'package.json', 'package-lock.json')
    with tarfile.open(fileobj=io.BytesIO(archive)) as stream:
        stream.extractall(baseline, filter='data')
    assert release.metadata(release.APP) == before
    workspace = RELEASE / 'workspace-before'
    for name in FILES:
        (workspace / name).parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(SERVER / name, workspace / name)
    shutil.copytree(baseline, RELEASE / 'candidate')
    release.save('capture.json', {'app': before, 'dependencies': dependencies})
    print(json.dumps({'captured': True, 'workspaceDifferences': [name for name in FILES
        if (baseline / name).read_bytes() != (workspace / name).read_bytes()]}), flush=True)


def prepare():
    captured = json.loads((RELEASE / 'capture.json').read_text())
    patch = ''.join(''.join(difflib.unified_diff(
        (RELEASE / 'workspace-before' / name).read_text().splitlines(True),
        (SERVER / name).read_text().splitlines(True), fromfile='a/' + name, tofile='b/' + name)) for name in FILES)
    shutil.rmtree(RELEASE / 'candidate')
    shutil.copytree(RELEASE / 'before', RELEASE / 'candidate')
    release.apply_patch(RELEASE / 'candidate', patch, 'feature')
    assert not (RELEASE / 'candidate' / MIGRATION).exists()
    shutil.copy2(SERVER / MIGRATION, RELEASE / 'candidate' / MIGRATION)
    before_tree = release.files_at(RELEASE / 'before')
    candidate_tree = release.files_at(RELEASE / 'candidate')
    changed = [name for name in candidate_tree if before_tree.get(name) != candidate_tree[name]]
    assert set(changed) == set(FILES + [MIGRATION]), changed
    release.save('manifest.json', {**captured, 'files': changed, 'beforeTree': before_tree,
        'candidateTree': candidate_tree, 'candidateTreeHash': release.sha(json.dumps(candidate_tree, sort_keys=True).encode()),
        'workspace': {name: release.sha((SERVER / name).read_bytes()) for name in changed}})
    changed_lines = {}
    for name in FILES[:4]:
        old = (RELEASE / 'before' / name).read_text().splitlines()
        new = (RELEASE / 'candidate' / name).read_text().splitlines()
        changed_lines[name] = [i + 1 for tag, _a, _b, start, end in difflib.SequenceMatcher(a=old, b=new).get_opcodes()
                              if tag in ['replace', 'insert'] for i in range(start, end)
                              if new[i].strip() and not new[i].strip().startswith(('//', '/*', '*'))
                              and new[i].strip() not in ['}', '});', '}', '];']]
    release.save('changed-lines.json', changed_lines)
    release.current(release.state())
    print('Prepared scoped candidate', flush=True)


def validated():
    out = SERVER / 'test-artifacts/backorder-already-ordered-20261008'
    report = json.loads((out / 'final/report.json').read_text())
    proofs = json.loads((out / 'proofs/report.json').read_text())
    assert report['passed'] and proofs['passed'] and report['hashes'] == proofs['hashes']
    assert proofs['coverage']['uncoveredLines'] == []
    assert all(release.sha((RELEASE / 'candidate' / name).read_bytes()) == value for name, value in report['hashes'].items())
    data = release.state()
    release.current(data)
    assert json.loads((out / 'proofs/source-state.json').read_text()) == data['candidateTree']
    release.save('validation-passed.json', {'passed': True, 'candidateTreeHash': data['candidateTreeHash'], 'report': report, 'proofs': proofs})
    print('Exact candidate validation recorded', flush=True)


def verify():
    data = release.state()
    release.ready(data['candidateImageId'])
    live = release.metadata(release.APP)
    assert live['imageId'] == data['candidateImageId']
    assert live['configuration'] == data['app']['configuration']
    assert [release.metadata(name) for name in release.DEPENDENCIES] == data['dependencies']
    assert json.loads(release.docker('exec', release.APP, 'node', '-e', release.HASH_SCRIPT)) == data['candidateTree']
    assert release.sql("SELECT count(*) FROM schema_migrations WHERE filename='274_backorder_already_ordered.sql'") == '1'
    result = {'deployed': True, 'at': release.now(), 'imageId': live['imageId'], 'files': data['files'],
              'configurationPreserved': True, 'dependenciesPreserved': True, 'productionHealthy': True}
    release.save('deployment-result.json', result)
    print(json.dumps(result), flush=True)


def apply():
    data = release.state()
    release.current(data)
    check = json.loads((RELEASE / 'image-check.json').read_text())
    assert check['passed'] and check['imageId'] == data['candidateImageId']
    release.config_check(data)
    release.assert_no_active_operations(release.preflight())
    applied = json.loads(release.sql("SELECT coalesce(json_agg(filename ORDER BY filename),'[]'::json) FROM schema_migrations"))
    if not (RELEASE / 'migrations-before.json').exists():
        release.save('migrations-before.json', applied)
    if not (RELEASE / 'schema-before.sql').exists():
        with (RELEASE / 'schema-before.sql').open('wb') as output:
            subprocess.run(['docker', 'exec', release.DB, 'pg_dump', '-U', 'mbbs_app', '-d', 'mbbs_yard',
                            '--schema-only', '--no-owner', '--no-acl'], stdout=output, check=True, timeout=30)
    if Path(MIGRATION).name not in applied:
        statement = (RELEASE / 'candidate' / MIGRATION).read_text()
        result = release.sql("BEGIN; SET LOCAL lock_timeout='10s'; SET LOCAL statement_timeout='30s';\n" + statement
            + "\nINSERT INTO schema_migrations(filename) VALUES('274_backorder_already_ordered.sql'); COMMIT;")
        (RELEASE / 'migration.log').write_text(result + '\n')
    release.current(data)
    release.assert_no_active_operations(release.preflight())
    args = ['up', '-d', '--no-build', '--no-deps', '--pull', 'never', 'app']
    try:
        with (RELEASE / 'cutover.log').open('wb') as output:
            subprocess.run(release.compose(data, 'release') + args, cwd=ROOT, stdout=output,
                           stderr=subprocess.STDOUT, check=True, timeout=60)
        verify()
    except BaseException:
        # The additive migration and saved references are retained on rollback.
        # Once users save the new status, restore service with compatible code.
        assert release.sql("SELECT count(*) FROM sales_special_stock_lines WHERE supply_status='already_ordered'") == '0', 'New status is in use; retain compatible runtime'
        with (RELEASE / 'rollback.log').open('wb') as output:
            subprocess.run(release.compose(data, 'rollback') + args, cwd=ROOT, stdout=output,
                           stderr=subprocess.STDOUT, check=True, timeout=60)
        release.ready(data['app']['imageId'])
        raise


if __name__ == '__main__':
    os.umask(0o022)
    if sys.argv[1] == 'build':
        atexit.register(release.cleanup_manual)
    {'capture': capture, 'prepare': prepare, 'validated': validated, 'build': release.build, 'apply': apply, 'verify': verify}[sys.argv[1]]()
