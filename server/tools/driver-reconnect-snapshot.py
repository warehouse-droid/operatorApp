#!/usr/bin/env python3
"""Prepare a production snapshot in a private Git index; never commit or push.

Runtime bytes come exclusively from the verified release candidates. The normal
index and working tree are preserved. Run prepare/stage again after deployment
so the versioned evidence records the verified live image identities.
"""
import argparse
import base64
import datetime
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
from zoneinfo import ZoneInfo

SERVER = Path(__file__).resolve().parents[1]
ROOT = SERVER.parent
RELEASE = SERVER / 'deployments/driver-reconnect-20261016'
RECORD = SERVER / 'deployments/production-20261016-driver-reconnect'
PRIVATE = SERVER / 'test-artifacts/driver-reconnect-20261016/commit-snapshot'
INDEX = PRIVATE / 'index'
SUPPORT = SERVER / 'tools/driver-reconnect-snapshot-files.json'
RUNTIME = ('src/', 'public/', 'migrations/')


def sha(value):
    return hashlib.sha256(value).hexdigest()


def git(*args, input=None, private=False):
    env = os.environ.copy()
    if private:
        env['GIT_INDEX_FILE'] = str(INDEX)
    return subprocess.check_output(['git', *args], cwd=ROOT, input=input, env=env)


def save(path, value):
    path.write_text(json.dumps(value, indent=2) + '\n')


def now():
    return datetime.datetime.now(ZoneInfo('America/Toronto')).isoformat()


def files(folder):
    result = {}
    for directory in ['src', 'public', 'migrations']:
        for path in sorted((folder / directory).rglob('*')):
            assert not path.is_symlink(), 'Runtime symlink: ' + str(path)
            if path.is_file():
                result[str(path.relative_to(folder))] = path
    for name in ['package.json', 'package-lock.json']:
        path = folder / name
        assert path.is_file() and not path.is_symlink(), name
        result[name] = path
    for name in result:
        assert not any(part.startswith('.env') or part in ['data', 'node_modules'] for part in Path(name).parts)
        assert not name.endswith(('.orig', '.rej', '.bak')), 'Unexpected runtime backup: ' + name
    return result


def hashes(folder):
    return {name: sha(path.read_bytes()) for name, path in sorted(files(folder).items())}


def normal_index_hash():
    path = Path(git('rev-parse', '--git-path', 'index').decode().strip())
    if not path.is_absolute():
        path = ROOT / path
    return sha(path.read_bytes()) if path.exists() else None


def prepare():
    PRIVATE.mkdir(parents=True, exist_ok=True)
    RECORD.mkdir(parents=True, exist_ok=True)
    data = json.loads((RELEASE / 'manifest.json').read_text())
    validation = json.loads((RELEASE / 'validation-passed.json').read_text())
    assert validation['passed']
    assert validation['candidateTreeHash'] == data['candidateTreeHash']
    assert validation['workerTreeHash'] == data['workerTreeHash']
    services = {}
    for service, folder, tree_key, image_key in [
        ('app', 'candidate', 'candidateTree', 'candidateImageId'),
        ('webhook-worker', 'worker-candidate', 'workerTree', 'workerImageId')
    ]:
        values = hashes(RELEASE / folder)
        assert {n: h for n, h in values.items() if n.startswith(RUNTIME)} == data[tree_key]
        services[service] = {'imageId': data.get(image_key), 'files': values}
    deployment_file = RELEASE / 'deployment-result.json'
    deployment = json.loads(deployment_file.read_text()) if deployment_file.exists() else None
    deployed = bool(deployment and deployment.get('deployed')
        and deployment.get('appImageId') == services['app']['imageId']
        and deployment.get('workerImageId') == services['webhook-worker']['imageId'])
    manifest = {'preparedAtToronto': now(), 'baseCommit': git('rev-parse', 'HEAD').decode().strip(),
        'deployed': deployed, 'deployedAtToronto': deployment.get('atToronto') if deployed else None,
        'scope': 'User requested the deployed application snapshot, including required earlier changes.',
        'services': services, 'releaseFiles': data['files'], 'workerReleaseFiles': data['workerFiles'],
        'excludes': ['environment files and credentials', 'database contents and business records',
            'uploads and R2 tickets', 'node_modules', 'unfinished workspace changes', 'generated deployment copies']}
    save(RECORD / 'manifest.json', manifest)
    originals = {'app': RELEASE / 'candidate', 'webhook-worker': RELEASE / 'worker-candidate'}
    mirror = PRIVATE / 'runtime'
    for service, source in originals.items():
        destination = mirror / service
        if destination.exists():
            shutil.rmtree(destination)
        for name, path in files(source).items():
            target = destination / name
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(path, target)
    removed = sorted(set(services['app']['files']) - set(services['webhook-worker']['files']))
    diff = subprocess.run(['git', 'diff', '--no-index', '--binary', '--no-renames', '--no-ext-diff', '--',
        'app', 'webhook-worker'], cwd=mirror, capture_output=True)
    assert diff.returncode in [0, 1]
    blocks = re.split(br'(?m)(?=^diff --git )', diff.stdout)
    deletions = [block for block in blocks if b'\ndeleted file mode ' in block]
    assert len(deletions) == len(removed)
    (RECORD / 'webhook-worker.patch').write_bytes(b''.join(block for block in blocks if block not in deletions))
    save(RECORD / 'worker-deletions.json', removed)
    # Apply outside the parent repository: git apply otherwise treats the
    # nested directory as a path prefix and can skip all runtime paths.
    with tempfile.TemporaryDirectory(prefix='mbbs-worker-snapshot-') as temp:
        destination = Path(temp)
        shutil.copytree(mirror / 'app', destination, dirs_exist_ok=True)
        subprocess.run(['git', 'apply', '-p2', str(RECORD / 'webhook-worker.patch')], cwd=destination, check=True)
        for name in removed:
            (destination / name).unlink()
        assert hashes(destination) == services['webhook-worker']['files']
    (RECORD / 'restore-worker.py').write_bytes((SERVER / 'deployments/production-20261003/restore-worker.py').read_bytes())
    with tempfile.TemporaryDirectory(prefix='mbbs-worker-helper-') as temp:
        clean = Path(temp) / 'checkout/server'
        shutil.copytree(mirror / 'app', clean)
        record = clean / 'deployments' / RECORD.name
        record.mkdir(parents=True)
        for name in ['manifest.json', 'restore-worker.py', 'webhook-worker.patch', 'worker-deletions.json']:
            shutil.copy2(RECORD / name, record / name)
        result = subprocess.check_output(['python3', str(record / 'restore-worker.py'), str(Path(temp) / 'worker')])
        (PRIVATE / 'worker-helper-check.log').write_bytes(result)
    if all(value['imageId'] for value in services.values()):
        (RECORD / 'images.compose.yml').write_text('services:\n' + ''.join(
            f'  {service}:\n    image: {value["imageId"]}\n' for service, value in services.items()))
    old = json.loads((SERVER / 'test-artifacts/driver-reconnect-20261016/evidence.json').read_text())
    browser = json.loads((SERVER / 'test-artifacts/driver-reconnect-20261016/browser-release-app/results/browser-report.json').read_text())
    timings = []
    def timing_attachments(value):
        if isinstance(value, dict):
            for attachment in value.get('attachments', []):
                if attachment.get('name') == 'completion-timing':
                    timings.append(json.loads(base64.b64decode(attachment['body'])))
            for key, child in value.items():
                if key != 'attachments':
                    timing_attachments(child)
        elif isinstance(value, list):
            for child in value:
                timing_attachments(child)
    timing_attachments(browser)
    assert len(timings) == 2 and all(row['status'] == 'complete' and row['nextStatus'] == 'in_progress'
        and row['elapsedMs'] < 5000 for row in timings)
    mutations = json.loads((SERVER / 'test-artifacts/driver-reconnect-20261016/release-validation/final/mutations.json').read_text())
    assert mutations['restored'] and all(row['properties'] for row in mutations['results'])
    evidence = {'validatedAtToronto': validation['atToronto'], 'deployed': deployed,
        'deployedAtToronto': manifest['deployedAtToronto'],
        'releaseChecks': {key: validation[key] for key in ['focused', 'integration', 'mobile', 'workerBilling',
            'changedLinesCovered', 'changedLinesTotal'] if key in validation},
        'completionTimingMs': timings,
        'completionTimingSource': 'Final release candidate Chromium/WebKit browser run; after photo upload.',
        'browserRunStartedAtToronto': datetime.datetime.fromisoformat(browser['stats']['startTime'].replace('Z', '+00:00')).astimezone(ZoneInfo('America/Toronto')).isoformat(),
        'toolVersions': old['toolVersions'],
        'mutationResult': {'killedByProperties': sum(row['properties'] for row in mutations['results']),
            'killedByUnits': sum(row['units'] for row in mutations['results']), 'total': len(mutations['results']),
            'restored': mutations['restored'], 'source': 'Final release candidate mutations.json'},
        'regressionBaselines': {'driverExistingFailures': 7, 'dispatchExistingFailures': 22, 'newFailures': 0},
        'realStorageReplay': {'engines': ['Chromium', 'WebKit'], 'maximumPhotoEdge': 2048,
            'connectionFailureBeforeUpload': True, 'storedObjectAcknowledgementLost': True,
            'nativeReplayReadbackHashesVerified': True, 'manualCleanupPrefix': 'driver-reconnect-test/'},
        'workerReconstruction': {'verified': True, 'files': len(services['webhook-worker']['files']),
            'removedFromApp': len(removed)},
        'limitations': ['Historical six-incident root causes remain unproven.',
            'Five-second completion timing was verified after upload in isolated tests; outages have no latency guarantee.',
            'The PWA must be open to recover; operating-system suspension resumes on return.',
            'Lost R2 acknowledgements can create extra storage objects; job completion is protected from duplication.',
            'Existing open PWAs need an online reload to use the new JavaScript.',
            'Full-repository and physical-device tests were not performed.'],
        'reproduction': 'See README.md; raw replay and production audit records are deliberately excluded.'}
    if deployed:
        evidence['deploymentChecks'] = {key: deployment[key] for key in [
            'appConfigurationPreserved', 'workerConfigurationPreserved', 'databaseAndOllamaUnchanged',
            'appRuntimeFilesVerified', 'workerRuntimeFilesVerified', 'driverShell', 'assetVersion',
            'existingOpenPwaNeedsReload'] if key in deployment}
        evidence['migration'] = {'filename': '295_driver_upload_recovery_audit.sql',
            'registered': deployment['migration']['registered'],
            'indexValid': deployment['migration']['index']['valid'],
            'indexReady': deployment['migration']['index']['ready']}
    save(RECORD / 'verification.json', evidence)
    (RECORD / 'README.md').write_text('''# Deployed application snapshot: Driver reconnect

This snapshot records the verified application and its distinct webhook worker,
including required earlier deployed changes. Runtime bytes come from the release
candidate, with full hashes and immutable image identities in `manifest.json`.
The shared development workspace, credentials, database records, uploads, tickets,
and generated test artifacts are excluded.

Driver uploads and uncertain completion requests recover automatically. Completion
checks saved history before replay; Driver and Dispatch planning ignore billing
status while preserving closed/cancelled safeguards. The app logs completion stages,
connection failures and recovery. Drivers must reload the PWA online once active
submissions have finished to load shell v47.

`verification.json` records the exact release checks and known limitations. The
original real R2 replay remains valid because its upload client bytes are unchanged.
Historical incident cause attribution is not claimed.

The application runtime is under `server/src`, `server/public`, and
`server/migrations`. On a clean checkout, reconstruct the distinct worker into a
new directory with `python3 server/deployments/production-20261016-driver-reconnect/restore-worker.py /tmp/worker-source`.
The helper verifies every reconstructed file and does not deploy it.

Tests use pinned package dependencies plus the repository's bounded isolated
Docker configuration and `mbbs-tests.slice`. The reconnect unit, property,
integration and Playwright files are included. Host-specific release and replay
scripts additionally require the documented local browser image/toolchain,
ignored baseline/evidence captures, and separately supplied short-lived R2 test
tickets. They are preserved as operational tooling, not a credential-bearing or
self-contained replay of production records. Do not run release tooling from this
snapshot without preparing a fresh release capture.

`tools/driver-reconnect-snapshot.py` stages only an explicit support list and the
verified runtime into a private Git index. It never commits, updates branches,
pushes, or modifies the normal index. Re-run prepare and stage after deployment;
verify `deployed: true` before committing the resulting tree.
''')
    save(PRIVATE / 'prepared.json', {'atToronto': now(), 'appFiles': len(services['app']['files']),
        'workerFiles': len(services['webhook-worker']['files']), 'workerReconstructionVerified': True,
        'normalIndexSha256': normal_index_hash(), 'deployed': deployed})
    print(json.dumps({'prepared': True, 'appFiles': len(services['app']['files']),
        'workerFiles': len(services['webhook-worker']['files']), 'workerReconstructionVerified': True, 'deployed': deployed}))


def stage():
    manifest = json.loads((RECORD / 'manifest.json').read_text())
    assert git('rev-parse', 'HEAD').decode().strip() == manifest['baseCommit'], 'HEAD changed; prepare again'
    original_index = normal_index_hash()
    for service, folder in [('app', 'candidate'), ('webhook-worker', 'worker-candidate')]:
        assert hashes(RELEASE / folder) == manifest['services'][service]['files']
    paths = json.loads(SUPPORT.read_text())
    plan = {'server/' + name: path for name, path in files(RELEASE / 'candidate').items()}
    for name in paths:
        path = ROOT / name
        assert path.is_file() and not path.is_symlink(), name
        assert '..' not in Path(name).parts and not name.startswith(('server/src/', 'server/public/', 'server/migrations/'))
        assert not any(part in ['data', 'node_modules', 'test-artifacts'] or part.startswith('.env') for part in Path(name).parts), name
        plan[name] = path
    for path in RECORD.iterdir():
        if path.is_file():
            plan[str(path.relative_to(ROOT))] = path
    preserved = {str(path.relative_to(ROOT)): sha(path.read_bytes()) for path in plan.values()}
    save(PRIVATE / 'source-fingerprints.json', preserved)
    if INDEX.exists():
        INDEX.unlink()
    git('read-tree', manifest['baseCommit'], private=True)
    head = {}
    for row in git('ls-tree', '-r', '-z', manifest['baseCommit']).split(b'\0'):
        if row:
            meta, name = row.split(b'\t', 1)
            mode, _, oid = meta.decode().split()
            head[name.decode()] = (mode, oid)
    updates = []
    staged = {}
    for name, path in sorted(plan.items()):
        content = path.read_bytes()
        oid = git('hash-object', '-w', '--stdin', input=content).decode().strip()
        mode = head.get(name, ('100755' if path.stat().st_mode & 0o111 else '100644', ''))[0]
        updates.append(f'{mode} {oid}\t{name}\0')
        staged[name] = {'gitBlob': oid, 'sha256': sha(content)}
    removed = [name for name in head if name.startswith('server/')
        and name.removeprefix('server/').startswith(RUNTIME) and name not in plan]
    updates.extend(f'0 {"0" * 40}\t{name}\0' for name in removed)
    git('update-index', '-z', '--index-info', input=''.join(updates).encode(), private=True)
    tree = git('write-tree', private=True).decode().strip()
    (PRIVATE / 'staged.patch').write_bytes(git('diff', '--cached', '--no-ext-diff', '--unified=0', manifest['baseCommit'], private=True))
    (PRIVATE / 'staged-stat.txt').write_bytes(git('diff', '--cached', '--stat', manifest['baseCommit'], private=True))
    for name, value in staged.items():
        assert sha(git('show', ':' + name, private=True)) == value['sha256'], name
    assert normal_index_hash() == original_index, 'Normal index changed concurrently'
    assert all(sha((ROOT / name).read_bytes()) == value for name, value in preserved.items()), 'Input changed during staging'
    save(PRIVATE / 'staged-plan.json', {'baseCommit': manifest['baseCommit'], 'tree': tree, 'index': str(INDEX),
        'deployed': manifest['deployed'], 'normalIndexSha256': original_index, 'files': staged,
        'removedTrackedRuntimeFiles': removed, 'supportFiles': paths, 'normalIndexUntouched': True})
    print(json.dumps({'tree': tree, 'privateIndex': str(INDEX), 'plannedFiles': len(staged),
        'changedFiles': len(git('diff', '--cached', '--name-only', manifest['baseCommit'], private=True).splitlines()),
        'supportFiles': len(paths), 'removedTrackedRuntimeFiles': len(removed), 'normalIndexUntouched': True,
        'deployed': manifest['deployed']}))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command', choices=['prepare', 'stage'])
    args = parser.parse_args()
    {'prepare': prepare, 'stage': stage}[args.command]()
