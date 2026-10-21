"""Finish read-only verification of the authorized, recorded volume removals."""
import datetime
import hashlib
import json
import subprocess
from pathlib import Path

OUT = Path('/home/ubuntu/apps/operatorApp/server/test-artifacts/host-backup-audit-20261006')
EXPECTED = {
    '3d658386da03061f7ab4a835d875085bd2490e4855d5c055d3d1e4156f29bb76',
    '5a88368d166942e3dff3ec5d64921e68731ee02b571777032b7f99d195d9ccbe',
    'c491fa6da41b5e57a577f1ee4e236502e53d9a3d906473c948699181661e708b',
}
PRODUCTION = {
    'mbbs-operator-app-app-1',
    'mbbs-operator-app-db-1',
    'mbbs-operator-app-webhook-worker-1',
    'mbbs-operator-app-ollama-1',
}
PROTECTED = {
    'mbbs-operator-app-v2_app_data',
    'mbbs-operator-app-v2_ollama_models',
    'mbbs-operator-app-v2_postgres_data',
    'mbbs-operator-app_app_data',
    'mbbs-operator-app_ollama_models',
    'mbbs-operator-app_postgres_data',
}


def docker(*args):
    return subprocess.check_output(['docker', *args], timeout=30)


def identities(rows):
    # Docker does not promise an order for the Mounts array.
    return sorted(({
        'id': row['id'],
        'name': row['name'],
        'image': row['image'],
        'mounts': sorted(row['mounts'], key=lambda mount: mount['Destination']),
    } for row in rows), key=lambda row: row['name'])


plan = json.loads((OUT / 'remaining-volume-cleanup-plan.json').read_text())
progress = json.loads((OUT / 'remaining-volume-removal-progress.json').read_text())
assert {row['name'] for row in plan['volumes']} == EXPECTED
assert len(progress['removed']) == 3 and set(progress['removed']) == EXPECTED
assert set(plan['protectedNamedVolumes']) == PROTECTED

for flags, name in [(['ps'], 'remaining-final-docker-ps.log'),
                    (['ps', '-a'], 'remaining-final-docker-ps-a.log')]:
    inventory = docker(*flags, '--format', '{{.Names}} {{.Status}}').decode()
    (OUT / name).write_text(inventory)
    assert {line.split()[0] for line in inventory.splitlines()} == PRODUCTION

container_ids = docker('ps', '-aq').decode().splitlines()
containers = json.loads(docker('inspect', *container_ids))
current_identities = [{
    'id': row['Id'], 'name': row['Name'], 'image': row['Image'],
    'mounts': row['Mounts'],
} for row in containers]
assert identities(current_identities) == identities(plan['productionContainers']), 'Production container identity or mounts changed'
for row in containers:
    assert row['State']['Running']
    if 'Health' in row['State']:
        assert row['State']['Health']['Status'] == 'healthy'

remaining_volumes = set(docker('volume', 'ls', '-q').decode().splitlines())
assert not EXPECTED & remaining_volumes
assert remaining_volumes == PROTECTED, 'Unexpected volume inventory'
named_volumes = json.loads(docker('volume', 'inspect', *sorted(PROTECTED)))
started_at = datetime.datetime.fromisoformat(plan['at'])
for row in named_volumes:
    created_at = datetime.datetime.fromisoformat(row['CreatedAt'].replace('Z', '+00:00'))
    assert created_at < started_at, 'A protected volume was recreated during cleanup'
    assert row['Driver'] == 'local'

networks = docker('network', 'ls', '--format', '{{.Name}}').decode().splitlines()
assert set(networks) == {
    'bridge', 'host', 'none', 'mbbs-operator-app_mbbs', 'mbbs-operator-app-v2_mbbs',
}, 'Unexpected network inventory'

backup_audit = json.loads((OUT / 'final-audit.json').read_text())
backups = backup_audit['fullBackupsKept']
assert len(backups) == 5
backup_root = Path('/home/ubuntu/apps/operatorApp/backups')
assert {str(path) for path in backup_root.rglob('*.dump')
        if path.is_file() and not path.is_symlink()} == {row['path'] for row in backups}
for row in backups:
    path = Path(row['path'])
    assert path.stat().st_size == row['bytes']
    with path.open('rb') as stream:
        assert hashlib.file_digest(stream, 'sha256').hexdigest() == row['sha256'], 'Retained backup changed'

health = json.loads(docker(
    'exec', 'mbbs-operator-app-app-1', 'node', '-e',
    "fetch('http://127.0.0.1:3000/health').then(async r=>{if(!r.ok)process.exit(1);console.log(JSON.stringify(await r.json()))})",
))
assert health['ok']
app = next(row for row in containers if row['Name'] == '/mbbs-operator-app-app-1')
assert app['RestartCount'] == 0

result = {
    'passed': True,
    'at': datetime.datetime.now(datetime.timezone.utc).isoformat(),
    'removedVolumes': progress['removed'],
    'removedCount': len(progress['removed']),
    'allocatedBytesRemoved': sum(row['allocatedBytes'] for row in plan['volumes']),
    'remainingAnonymousDatabaseVolumes': 0,
    'protectedNamedVolumes': sorted(PROTECTED),
    'protectedVolumeCreationDatesPredateCleanup': True,
    'productionIdentitiesAndMountsUnchanged': True,
    'runningAndStoppedContainers': sorted(PRODUCTION),
    'productionHealthy': True,
    'appRestarts': app['RestartCount'],
    'latestFiveBackupHashesUnchanged': True,
    'retainedBackupPaths': [row['path'] for row in backups],
    'networks': sorted(networks),
    'verificationNote': 'The initial comparison treated mount ordering as significant. Verification compares every mount field sorted by destination.',
}
(OUT / 'remaining-named-volumes-after.json').write_text(json.dumps(named_volumes, indent=2) + '\n')
(OUT / 'remaining-volume-cleanup-result.json').write_text(json.dumps(result, indent=2) + '\n')
with (OUT / 'EVIDENCE.md').open('a') as stream:
    stream.write(
        '\nFollow-up ' + result['at'] + ': the user requested removal of the remaining excess database volumes. '
        'Removed the three previously preserved detached anonymous volumes holding mirror/verify databases '
        'after exact identity, offline catalogue hash and zero-attachment checks. No anonymous database volumes remain. '
        'The six named production and V2 rollback volumes remain; their creation dates predate cleanup. '
        'All four production container identities and every mount field are unchanged, comparing mounts by destination. '
        'The initial verification stopped on array ordering; normalized verification passes. '
        'Both docker ps and docker ps -a contain only production. Production health passes with zero app restarts; '
        'all five retained full-backup hashes match. Released ' + str(result['allocatedBytesRemoved']) + ' allocated bytes. '
        'See remaining-volume-cleanup-plan.json, remaining-volume-removal-progress.json and remaining-volume-cleanup-result.json; '
        'earlier records describe the state before this follow-up.\n'
    )
print(json.dumps(result))
