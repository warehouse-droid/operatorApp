"""Release the tested regular-stock changes over the current production image."""
import atexit
import difflib
import importlib.util
import io
import json
import os
from pathlib import Path
import re
import shutil
import sys
import tarfile

SERVER = Path(__file__).resolve().parents[1]
ARTIFACT = SERVER / 'test-artifacts/already-ordered-arrival-20261020'
spec = importlib.util.spec_from_file_location('prior_status_release', SERVER / 'tools/unified-stock-status-release.py')
prior = importlib.util.module_from_spec(spec)
spec.loader.exec_module(prior)
r = prior.r
r.RELEASE = SERVER / 'deployments/already-ordered-arrival-20261020'
r.IMAGE = 'mbbs-operator-app:already-ordered-arrival-20261020'
r.ROLLBACK = r.IMAGE + '-rollback'
r.READ_NAME = 'mbbs-already-ordered-arrival-release-reader'
r.CHECK_NAME = 'mbbs-already-ordered-arrival-release-check'


def results(folder):
    result = []
    for name in ['full.log', 'regressions.log']:
        text = (folder / name).read_text()
        values = {key: int(re.findall(r'^# ' + key + r' (\d+)$', text, re.M)[-1]) for key in ['tests', 'pass', 'fail']}
        assert values['fail'] == 0 and values['tests'] == values['pass'], (name, values)
        result.append({'file': name, **values})
    legacy = json.loads((folder / 'baseline-comparison.json').read_text())
    assert legacy['newFailures'] == 0
    result.append({'file': 'legacy.log', **{k: legacy['current'][k] for k in ['tests', 'passed', 'failed']}, 'baselineFailuresOnly': True})
    return result


def prepare():
    static = json.loads((ARTIFACT / 'static.json').read_text())
    assert all(r.sha((SERVER / n).read_bytes()) == h for n, h in static['hashes'].items()), 'Tested files changed'
    tested = results(ARTIFACT)
    r.RELEASE.mkdir(parents=True, exist_ok=False)
    before = r.metadata(r.APP)
    dependencies = [r.metadata(n) for n in r.DEPENDENCIES]
    baseline = r.RELEASE / 'before'
    baseline.mkdir()
    archive = r.docker('exec', r.APP, 'tar', '-cf', '-', '-C', '/app', 'src', 'public', 'migrations', 'package.json', 'package-lock.json')
    with tarfile.open(fileobj=io.BytesIO(archive)) as stream:
        stream.extractall(baseline, filter='data')
    assert r.metadata(r.APP) == before
    for p in baseline.rglob('*'):
        p.chmod(p.stat().st_mode | (0o055 if p.is_dir() else 0o044))
    candidate = r.RELEASE / 'candidate'
    shutil.copytree(baseline, candidate)
    patch, expected = '', []
    for name in json.loads((SERVER / 'tools/already-ordered-arrival-files.json').read_text()):
        old = ARTIFACT / 'before' / name
        if old.exists():
            if old.read_bytes() == (SERVER / name).read_bytes():
                continue
            patch += ''.join(difflib.unified_diff(old.read_text().splitlines(True), (SERVER / name).read_text().splitlines(True), fromfile='a/' + name, tofile='b/' + name, n=3))
        else:
            assert not (candidate / name).exists(), 'New module already exists: ' + name
            shutil.copy2(SERVER / name, candidate / name)
        expected.append(name)
    r.apply_patch(candidate, patch, 'already-ordered-arrival')
    old_tree, tree = r.files_at(baseline), r.files_at(candidate)
    changed = sorted(n for n in old_tree.keys() | tree.keys() if old_tree.get(n) != tree.get(n))
    assert changed == sorted(expected), changed
    data = {'capturedAt': r.now(), 'app': before, 'dependencies': dependencies, 'files': changed,
            'beforeTree': old_tree, 'candidateTree': tree, 'candidateTreeHash': r.sha(json.dumps(tree, sort_keys=True).encode()),
            'workspace': {n: static['hashes'][n] for n in changed}, 'tests': tested,
            'packages': {n: r.sha((candidate / n).read_bytes()) for n in ['package.json', 'package-lock.json']}}
    r.save('manifest.json', data)
    r.current(data)
    print(json.dumps({'prepared': True, 'changedFiles': changed, 'candidateDifferences': [n for n in changed if tree[n] != static['hashes'][n]]}), flush=True)


def validated():
    data = r.state()
    r.current(data)
    output = r.RELEASE / 'validation-artifacts/already-ordered-arrival-20261020'
    checks = results(output)
    assert checks == data['tests'], 'Candidate regression totals differ'
    static = json.loads((output / 'static.json').read_text())
    assert all(static['hashes'][n] == data['candidateTree'][n] for n in data['files'])
    coverage = json.loads((output / 'changed-line-coverage.json').read_text())
    assert all(not row.get('missingCoverage') and not row['uncovered'] for row in coverage), 'Changed code lacks execution evidence'
    assert (r.RELEASE / 'validation-cleanup-passed').exists()
    assert all(line.endswith(' healthy') for line in (output / 'production-health-full.log').read_text().splitlines())
    assert (output / 'production-http-health-full.log').read_text().strip() == '200'
    assert not (output / 'volumes-full.log').read_text().strip()
    assert not (output / 'networks-full.log').read_text().strip()
    r.save('validation-passed.json', {'passed': True, 'at': r.now(), 'candidateTreeHash': data['candidateTreeHash'],
                                     'tests': checks, 'changedLinesCovered': sum(row['covered'] for row in coverage)})
    print(json.dumps({'validated': True, 'tests': checks}), flush=True)


def verify():
    data = r.state()
    r.ready(data['candidateImageId'])
    live = r.metadata(r.APP)
    assert live['imageId'] == data['candidateImageId']
    assert live['configuration'] == data['app']['configuration']
    assert [r.metadata(n) for n in r.DEPENDENCIES] == data['dependencies']
    assert json.loads(r.docker('exec', r.APP, 'node', '-e', r.HASH_SCRIPT)) == data['candidateTree']
    checked = prior.http_check(data)
    readback = r.docker('exec', '-i', '-w', '/app', r.APP, 'node', '--input-type=module',
                       input=(SERVER / 'tools/already-ordered-arrival-live-verify.mjs').read_bytes(), timeout=60)
    (r.RELEASE / 'completed-request-readback.jsonl').write_bytes(readback)
    r.save('deployment-result.json', {'deployed': True, 'at': r.now(), 'image': r.IMAGE, 'imageId': live['imageId'],
                                     'changedFiles': data['files'], 'http': checked, 'configurationPreserved': True,
                                     'candidateTreeHash': data['candidateTreeHash'], 'dependentServicesPreserved': True,
                                     'schemaMigration': '299_backorder_arrival_reads.sql'})
    print(json.dumps({'deployed': True, 'image': r.IMAGE, 'http': checked}), flush=True)


def migrate():
    data = r.state()
    r.current(data)
    name = '299_backorder_arrival_reads.sql'
    source = (r.RELEASE / 'candidate/migrations' / name).read_text()
    assert r.sha(source.encode()) == data['candidateTree']['migrations/' + name]
    applied = r.sql("SELECT count(*) FROM schema_migrations WHERE filename='" + name + "'")
    if applied == '0':
        sql = """BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='15s';
DO $arrival_migration$
DECLARE previous jsonb; current_rows jsonb;
BEGIN
  LOCK TABLE regular_stock_decision_reads IN ACCESS EXCLUSIVE MODE;
  SELECT COALESCE(jsonb_agg(to_jsonb(entry) ORDER BY request_id,operator_id),'[]'::jsonb)
    INTO previous FROM regular_stock_decision_reads entry;
  MIGRATION_SQL
  SELECT COALESCE(jsonb_agg(to_jsonb(entry)-'backorder_arrival_key' ORDER BY request_id,operator_id),'[]'::jsonb)
    INTO current_rows FROM regular_stock_decision_reads entry;
  IF previous IS DISTINCT FROM current_rows THEN RAISE EXCEPTION 'Existing read history changed'; END IF;
  INSERT INTO schema_migrations(filename) VALUES('299_backorder_arrival_reads.sql');
END; $arrival_migration$;
COMMIT;
""".replace('MIGRATION_SQL', source)
        r.sql(sql)
    assert r.sql("SELECT count(*) FROM information_schema.columns WHERE table_schema='public' AND table_name='regular_stock_decision_reads' AND column_name='backorder_arrival_key' AND data_type='text' AND is_nullable='NO'") == '1'
    r.save('migration-result.json', {'migration': name, 'at': r.now(), 'appliedNow': applied == '0',
        'sha256': r.sha(source.encode()), 'additive': True, 'existingReadHistoryPreserved': True,
        'rollback': 'The prior application can run with the additional column; keep receipt acknowledgements.'})


def apply():
    data = r.state()
    r.current(data)
    check = json.loads((r.RELEASE / 'image-check.json').read_text())
    assert check['passed'] and check['imageId'] == data['candidateImageId']
    r.config_check(data)
    r.assert_no_active_operations(r.preflight())
    migrate()
    prior.cutover.apply()


prior.cutover.verify = verify
if __name__ == '__main__':
    os.umask(0o022)
    if sys.argv[1] in ['build', 'apply', 'verify']:
        atexit.register(r.cleanup_manual)
    {'prepare': prepare, 'validated': validated, 'build': r.build, 'apply': apply, 'verify': verify}[sys.argv[1]]()
