"""Capture deployed source without secrets, audit local drift and stage a snapshot.

Runtime files are staged from the captured containers without overwriting the
working tree. Development files remain ordinary repository files. Unreleased
Dispatch-review sources/tests, backup files and generated archives stay local.
"""
import datetime
import hashlib
import io
import json
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile

SERVER = Path(__file__).resolve().parents[1]
ROOT = SERVER.parent
CAPTURE = SERVER / 'test-artifacts/production-commit-20260925'
RECORD = SERVER / 'deployments/production-20260925'
SERVICES = {'app': 'mbbs-operator-app-app-1', 'webhook-worker': 'mbbs-operator-app-webhook-worker-1'}
RUNTIME_DIRS = ('src/', 'public/', 'migrations/')


def git(*args, input=None):
    return subprocess.check_output(['git', *args], cwd=ROOT, input=input)


def docker(*args, input=None):
    return subprocess.check_output(['sudo', '-n', 'docker', *args], input=input)


def digest(data):
    return hashlib.sha256(data).hexdigest()


def files(folder):
    return {str(file.relative_to(folder)): file for file in folder.rglob('*') if file.is_file()}


def hashes(folder):
    return {name: digest(file.read_bytes()) for name, file in sorted(files(folder).items())}


def metadata(container):
    row = json.loads(docker('inspect', container))[0]
    assert row['State']['Running']
    # Never persist environment values, credentials, mounts containing business
    # documents, or raw inspect output in the repository.
    return {'image': row['Config']['Image'], 'imageId': row['Image'],
            'containerId': row['Id'], 'startedAt': row['State']['StartedAt']}


def capture():
    assert not git('diff', '--cached', '--name-only').strip(), 'Existing staged work must be preserved'
    CAPTURE.mkdir(parents=True, exist_ok=False)
    RECORD.mkdir(parents=True, exist_ok=False)
    manifest = {'capturedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(),
        'baseCommit': git('rev-parse', 'HEAD').decode().strip(), 'services': {},
        'excludes': ['environment/credentials', 'business data', 'uploads', 'node_modules', 'Docker volumes']}
    for service, container in SERVICES.items():
        before = metadata(container)
        listing = json.loads(docker('exec', container, 'node', '--input-type=module', '-e',
            'import fs from "node:fs";console.log(JSON.stringify(fs.readdirSync("/app")));'))
        names = ['src', 'public', 'migrations', 'package.json', 'package-lock.json', 'tools']
        names += sorted(name for name in listing if re.fullmatch(r'netsuite-[a-z0-9-]+\.js', name))
        data = docker('exec', container, 'tar', '-C', '/app', '-cf', '-', *names)
        folder = CAPTURE / service
        folder.mkdir()
        with tarfile.open(fileobj=io.BytesIO(data)) as archive:
            assert not any(member.name.split('/')[-1].startswith('.env') for member in archive.getmembers())
            archive.extractall(folder, filter='data')
        assert metadata(container) == before, 'Service changed during capture'
        manifest['services'][service] = {**before, 'files': hashes(folder)}
    schema = docker('exec', '-i', 'mbbs-operator-app-db-1', 'psql', '-U', 'mbbs_app', '-d', 'mbbs_yard',
        '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', input=b"BEGIN READ ONLY; SET LOCAL statement_timeout='10s'; SELECT filename FROM schema_migrations ORDER BY filename; COMMIT;")
    manifest['appliedMigrations'] = schema.decode().splitlines()
    (RECORD / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
    worker_delta()
    (RECORD / 'images.compose.yml').write_text('services:\n' + ''.join(
        f'  {service}:\n    image: {row["imageId"]}\n' for service, row in manifest['services'].items()))
    audit()
    print(json.dumps({'captured': {service: len(row['files']) for service, row in manifest['services'].items()},
                      'workerReconstructionVerified': True}))


def worker_delta():
    manifest = json.loads((RECORD / 'manifest.json').read_text())
    # Record deletions separately: a binary deletion patch would duplicate the
    # app's large PDF fonts even though the worker does not contain those fonts.
    removed = sorted(set(manifest['services']['app']['files']) - set(manifest['services']['webhook-worker']['files']))
    patch = subprocess.run(['git', 'diff', '--no-index', '--binary', '--no-renames', '--no-ext-diff', '--', 'app', 'webhook-worker'],
                           cwd=CAPTURE, capture_output=True, check=False)
    assert patch.returncode in (0, 1), patch.stderr.decode()
    blocks = re.split(br'(?m)(?=^diff --git )', patch.stdout)
    deletions = [block for block in blocks if b'\ndeleted file mode ' in block]
    assert len(deletions) == len(removed)
    (RECORD / 'webhook-worker.patch').write_bytes(b''.join(block for block in blocks if block not in deletions))
    (RECORD / 'worker-deletions.json').write_text(json.dumps(removed, indent=2) + '\n')
    with tempfile.TemporaryDirectory(prefix='production-worker-reconstruction-') as temporary:
        restored = Path(temporary)
        shutil.copytree(CAPTURE / 'app', restored, dirs_exist_ok=True)
        subprocess.run(['git', 'apply', '-p2', str(RECORD / 'webhook-worker.patch')], cwd=restored, check=True)
        for name in removed:
            (restored / name).unlink()
        assert hashes(restored) == manifest['services']['webhook-worker']['files']
    print(json.dumps({'workerReconstructionVerified': True, 'deletions': len(removed),
                      'patchBytes': (RECORD / 'webhook-worker.patch').stat().st_size}))


def audit():
    manifest = json.loads((RECORD / 'manifest.json').read_text())
    deployed = manifest['services']['app']['files']
    local = {str(file.relative_to(SERVER)): file for directory in ['src', 'public', 'migrations']
             for file in (SERVER / directory).rglob('*') if file.is_file()}
    for name in deployed:
        if name not in local and (SERVER / name).is_file():
            local[name] = SERVER / name
    modified = sorted(name for name in local.keys() & deployed.keys() if digest(local[name].read_bytes()) != deployed[name])
    pending = sorted(name for name in local.keys() - deployed.keys() if not name.endswith('.orig'))
    ignored = sorted(name for name in local.keys() - deployed.keys() if name.endswith('.orig'))
    result = {'capturedAt': manifest['capturedAt'], 'modifiedFromApp': modified,
        'workspaceOnlyRuntimeFiles': pending, 'localBackupFilesExcluded': ignored,
        'appliedMigrationsMissingFromAppImage': sorted(set(manifest['appliedMigrations']) - {
            name.removeprefix('migrations/') for name in deployed if name.startswith('migrations/')})}
    (RECORD / 'workspace-differences.json').write_text(json.dumps(result, indent=2) + '\n')
    # Persist a private preservation fingerprint, without storing file contents.
    paths = git('ls-files', '-z', '--cached', '--others', '--exclude-standard').split(b'\0')
    preserved = {name.decode(): digest((ROOT / name.decode()).read_bytes()) for name in paths
        if name and (ROOT / name.decode()).is_file() and not name.decode().startswith('server/deployments/production-20260925/')}
    (CAPTURE / 'working-tree-before.json').write_text(json.dumps(preserved, indent=2) + '\n')


def exclusions():
    scope = json.loads((SERVER / 'tools/executed-order-review-files.json').read_text())
    result = {'server/' + name for name in scope['tests']}
    result.add('server/test/dispatch-executed-order-review-evidence.md')
    result.update('server/' + str(file.relative_to(SERVER)) for file in (SERVER / 'tools').glob('executed-order-review*'))
    return result


def stage():
    manifest = json.loads((RECORD / 'manifest.json').read_text())
    assert git('rev-parse', 'HEAD').decode().strip() == manifest['baseCommit']
    assert not git('diff', '--cached', '--name-only').strip(), 'Index changed before snapshot staging'
    for service, container in SERVICES.items():
        assert metadata(container) == {key: value for key, value in manifest['services'][service].items() if key != 'files'}
        assert hashes(CAPTURE / service) == manifest['services'][service]['files']
    head = {}
    for entry in git('ls-tree', '-r', '-z', 'HEAD').split(b'\0'):
        if not entry:
            continue
        header, path = entry.split(b'\t', 1)
        mode, _, oid = header.decode().split()
        head[path.decode()] = (mode, oid)
    plan = {}
    excluded = exclusions()
    all_paths = git('ls-files', '-z', '--cached', '--others', '--exclude-standard').split(b'\0')
    app = files(CAPTURE / 'app')
    for raw in all_paths:
        if not raw:
            continue
        name = raw.decode()
        relative = name.removeprefix('server/')
        if name in excluded or name.endswith(('.orig', '.tar.gz', '.zip', '.dump')):
            continue
        if name.startswith('server/') and relative.startswith(RUNTIME_DIRS):
            continue
        path = ROOT / name
        if path.is_file():
            plan[name] = path
    for relative, path in app.items():
        plan['server/' + relative] = path
    private_names = [name for name in plan if Path(name).name.startswith('.env') and not name.endswith('.env.example')]
    assert not private_names, 'Environment file would be staged'
    sizes = {name: file.stat().st_size for name, file in plan.items() if file.stat().st_size > 5_000_000
             and name.removeprefix('server/') not in app}
    assert not sizes, 'Large generated files require review: ' + json.dumps(sizes)
    updates, blobs = [], {}
    for name, path in sorted(plan.items()):
        content = path.read_bytes()
        oid = git('hash-object', '-w', '--stdin', input=content).decode().strip()
        mode = head.get(name, ('100755' if path.stat().st_mode & 0o111 else '100644', ''))[0]
        updates.append(f'{mode} {oid}\t{name}\0')
        blobs[name] = {'gitBlob': oid, 'sha256': digest(content)}
    # Any tracked runtime file absent from the actual app belongs outside this
    # production snapshot. Its local content, if present, remains untouched.
    for name in head:
        if name.startswith('server/') and name.removeprefix('server/').startswith(RUNTIME_DIRS) and name not in plan:
            updates.append(f'0 {"0" * 40}\t{name}\0')
    git('update-index', '-z', '--index-info', input=''.join(updates).encode())
    (CAPTURE / 'staged-plan.json').write_text(json.dumps(blobs, indent=2) + '\n')
    verify('index')
    print(json.dumps({'stagedProductionFiles': len(app), 'stagedRepositoryFiles': len(plan),
                      'unreleasedTestAndToolFilesExcluded': len(excluded)}))


def verify(target='HEAD'):
    manifest = json.loads((RECORD / 'manifest.json').read_text())
    for name, expected in manifest['services']['app']['files'].items():
        spec = ':server/' + name if target == 'index' else target + ':server/' + name
        assert digest(git('show', spec)) == expected, 'Snapshot mismatch: ' + name
    before = json.loads((CAPTURE / 'working-tree-before.json').read_text())
    changed = [name for name, sha in before.items() if not (ROOT / name).is_file() or digest((ROOT / name).read_bytes()) != sha]
    assert not changed, 'Working tree changed during snapshot: ' + json.dumps(changed)
    print(json.dumps({'verified': target, 'productionFiles': len(manifest['services']['app']['files']),
                      'workingTreePreserved': True}))


if __name__ == '__main__':
    {'capture': capture, 'audit': audit, 'stage': stage, 'verify': verify, 'worker-delta': worker_delta}[sys.argv[1]]()
