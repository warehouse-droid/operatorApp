"""Publish the tested scoped Driver reopen fix and repair TOB01193's catalogue."""
import importlib.util
import io
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tarfile
import threading
import time
import urllib.request

SERVER = Path(__file__).resolve().parents[1]
ROOT = SERVER.parent
RELEASE = SERVER / 'deployments/driver-reopen-replan-20261006'
ARTIFACT = SERVER / 'test-artifacts/driver-reopen-replan-20261006'
spec = importlib.util.spec_from_file_location('release_helpers', SERVER / 'tools/delivery-scm-release.py')
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)
release.RELEASE = RELEASE
release.IMAGE = 'mbbs-operator-app:driver-reopen-replan-20261006'
release.ROLLBACK = release.IMAGE + '-rollback'
release.READ_NAME = 'mbbs-driver-reopen-baseline-reader'
release.CHECK_NAME = 'mbbs-driver-reopen-image-check'
MIGRATION = '267_driver_reopen_completion_cycles.sql'


def recapture():
    """Preserve concurrent releases and rebase only the reviewed three files."""
    old = release.state()
    assert all(release.sha((SERVER / name).read_bytes()) == digest
        for name, digest in old['workspace'].items()), 'Reviewed workspace changed'
    app = release.metadata(release.APP)
    dependencies = [release.metadata(name) for name in release.DEPENDENCIES]
    archived = RELEASE / 'recaptures' / release.now().replace(':', '-')
    archived.mkdir(parents=True)
    for name in ['before', 'candidate', 'manifest.json', 'capture.json']:
        shutil.move(str(RELEASE / name), str(archived / name))
    before = RELEASE / 'before'
    before.mkdir()
    archive = release.docker('exec', release.APP, 'tar', '-cf', '-', '-C', '/app',
        'src', 'public', 'migrations', 'package.json', 'package-lock.json')
    with tarfile.open(fileobj=io.BytesIO(archive)) as stream:
        stream.extractall(before, filter='data')
    # Tar preserves image ownership; the test image's node user needs to read
    # these source-only bind mounts. File contents and runtime hashes stay exact.
    for path in before.rglob('*'):
        if path.is_file():
            path.chmod(path.stat().st_mode | 0o044)
        elif path.is_dir():
            path.chmod(path.stat().st_mode | 0o055)
    assert release.metadata(release.APP) == app, 'Live application changed during capture'
    assert all(release.sha((before / name).read_bytes()) == old['beforeTree'][name]
        for name in ['src/server.js', 'src/driver-pwa-repository.js']), 'Runtime requires a reviewed patch rebase'
    candidate = RELEASE / 'candidate'
    shutil.copytree(before, candidate)
    for name in old['files']:
        assert name in old['beforeTree'] or not (candidate / name).exists(), 'New migration already exists'
        shutil.copy2(archived / 'candidate' / name, candidate / name)
    before_tree, candidate_tree = release.files_at(before), release.files_at(candidate)
    changed = sorted(name for name in before_tree.keys() | candidate_tree.keys()
        if before_tree.get(name) != candidate_tree.get(name))
    assert changed == sorted(old['files']), 'Release scope changed'
    capture = {'app': app, 'dependencies': dependencies, 'beforeTree': before_tree,
        'capturedAt': release.now()}
    data = {**capture, 'files': old['files'], 'workspace': old['workspace'],
        'candidateTree': candidate_tree,
        'candidateTreeHash': release.sha(json.dumps(candidate_tree, sort_keys=True).encode()),
        'packages': {name: release.sha((candidate / name).read_bytes())
            for name in ['package.json', 'package-lock.json']}}
    release.save('capture.json', capture)
    release.save('manifest.json', data)
    release.current(data)
    print(json.dumps({'rebased': True, 'imageId': app['imageId'],
        'changedFiles': changed, 'candidateTreeHash': data['candidateTreeHash']}), flush=True)


def live(mode):
    expected = json.loads((RELEASE / 'database-before.json').read_text())
    body = (SERVER / 'tools/driver-reopen-replan-live.mjs').read_bytes()
    result = json.loads(release.docker('exec', '-i', '-e', 'MBT_TEST_ISOLATED=1',
        '-e', 'DRIVER_REOPEN_BEFORE_STATE=' + json.dumps(expected), release.APP,
        'node', '--input-type=module', '-', mode, input=body, timeout=90))
    release.save('live-' + mode + '.json', result)
    return result


def verify():
    data = release.state()
    release.ready(data['candidateImageId'])
    current = release.metadata(release.APP)
    assert current['imageId'] == data['candidateImageId']
    assert current['configuration'] == data['app']['configuration']
    assert [release.metadata(n) for n in release.DEPENDENCIES] == data['dependencies']
    assert json.loads(release.docker('exec', release.APP, 'node', '-e', release.HASH_SCRIPT)) == data['candidateTree']
    result = live('verify')
    release.save('deployment-result.json', {'deployed': True, 'at': release.now(),
        'image': release.IMAGE, 'imageId': current['imageId'],
        'candidateTreeHash': data['candidateTreeHash'], 'changedFiles': data['files'],
        'runtimeFilesVerified': len(data['candidateTree']), 'configurationPreserved': True,
        'dependentContainersUnchanged': True, 'order': result})
    print(json.dumps({'deployed': True, 'order': result}), flush=True)


def migrate():
    before = json.loads((RELEASE / 'database-before.json').read_text())
    current = json.loads(release.sql("SELECT json_build_object('effectiveView',pg_get_viewdef('dispatch_effective_order_completion_events'::regclass,true),'completionFunction',pg_get_functiondef('dispatch_record_order_completion(text,text,timestamp with time zone,text,text,bigint,date,text,text,text,text,jsonb)'::regprocedure),'uniqueIndex',(SELECT indexdef FROM pg_indexes WHERE indexname='idx_dispatch_order_completion_evidence_unique'));"))
    assert all(current[key] == before[key] for key in current), 'Reviewed database definitions changed'
    sql = (RELEASE / 'candidate/migrations' / MIGRATION).read_text()
    statement = "BEGIN; SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='30s'; SELECT pg_advisory_xact_lock(hashtext('dispatch_fleet_planning_mutation'));\n" + sql
    statement += "\nINSERT INTO schema_migrations(filename) VALUES ('" + MIGRATION + "'); COMMIT;"
    result = release.sql(statement)
    (RELEASE / 'migration.log').write_text(result + '\n')
    release.save('migration-result.json', {'applied': MIGRATION, 'at': release.now(),
        'transactional': True, 'completionHistoryDeleted': False,
        'backwardCompatibleWithPreviousImage': True})


def apply():
    data = release.state()
    release.current(data)
    check = json.loads((RELEASE / 'image-check.json').read_text())
    assert check['passed'] and check['imageId'] == data['candidateImageId']
    release.config_check(data)
    release.assert_no_active_operations(release.preflight())
    leases = release.edit_lease_identities()
    migrate()
    samples = []
    stop = threading.Event()
    started = time.monotonic()

    def probe():
        while not stop.is_set():
            try:
                with urllib.request.urlopen('http://127.0.0.1:3000/health', timeout=0.5) as response:
                    ok = response.status == 200
            except OSError:
                ok = False
            samples.append({'seconds': round(time.monotonic() - started, 3), 'ok': ok})
            stop.wait(0.2)

    thread = threading.Thread(target=probe, daemon=True)
    thread.start()
    args = ['up', '-d', '--no-build', '--no-deps', '--pull', 'never', 'app']
    try:
        with (RELEASE / 'cutover.log').open('wb') as output:
            subprocess.run(release.compose(data, 'release') + args, cwd=ROOT,
                stdout=output, stderr=subprocess.STDOUT, check=True, timeout=60)
        release.ready(data['candidateImageId'])
        live('repair')
        verify()
        after = release.edit_lease_identities()
        release.save('editing-leases.json', {'before': leases, 'after': after,
            'retained': set(leases) <= set(after)})
    except BaseException:
        with (RELEASE / 'rollback.log').open('wb') as output:
            subprocess.run(release.compose(data, 'rollback') + args, cwd=ROOT,
                stdout=output, stderr=subprocess.STDOUT, check=True, timeout=60)
        release.ready(data['app']['imageId'])
        release.save('rollback-result.json', {'restoredImageId': data['app']['imageId'],
            'backwardCompatibleMigrationRetained': True})
        raise
    finally:
        stop.set()
        thread.join(timeout=2)
        failed = [row['seconds'] for row in samples if not row['ok']]
        recovered = [row['seconds'] for row in samples if row['ok'] and failed and row['seconds'] > max(failed)]
        release.save('cutover.json', {'seconds': round(time.monotonic() - started, 3),
            'observedInterruptionSeconds': round(min(recovered)-min(failed), 3) if recovered else None if failed else 0,
            'samples': samples})


if __name__ == '__main__':
    {'recapture': recapture, 'build': release.build, 'apply': apply, 'verify': verify}[sys.argv[1]]()
