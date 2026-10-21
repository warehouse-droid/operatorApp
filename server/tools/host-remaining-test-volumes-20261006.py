"""Remove the three reviewed detached databases requested in the follow-up."""
import datetime,hashlib,json,subprocess
from pathlib import Path

OUT=Path('/home/ubuntu/apps/operatorApp/server/test-artifacts/host-backup-audit-20261006')
EXPECTED={
 '3d658386da03061f7ab4a835d875085bd2490e4855d5c055d3d1e4156f29bb76',
 '5a88368d166942e3dff3ec5d64921e68731ee02b571777032b7f99d195d9ccbe',
 'c491fa6da41b5e57a577f1ee4e236502e53d9a3d906473c948699181661e708b'
}
PRODUCTION={'mbbs-operator-app-app-1','mbbs-operator-app-db-1','mbbs-operator-app-webhook-worker-1','mbbs-operator-app-ollama-1'}

def docker(*args):return subprocess.check_output(['docker',*args])
def containers():
    ids=docker('ps','-aq').decode().splitlines()
    return json.loads(docker('inspect',*ids)) if ids else []
def identity(row):return {'id':row['Id'],'name':row['Name'],'image':row['Image'],'mounts':row['Mounts']}
def volume(name):return json.loads(docker('volume','inspect',name))[0]
def validate(expected):
    assert not any(m.get('Name')==expected['name'] for row in containers() for m in row.get('Mounts',[])), 'Volume became attached'
    row=volume(expected['name'])
    assert row['CreatedAt']==expected['createdAt'] and (row.get('Labels') or {})=={'com.docker.volume.anonymous':''}
    for name,digest in expected['catalogHashes'].items():
        path=Path(row['Mountpoint'])/name
        assert not path.is_symlink() and hashlib.sha256(path.read_bytes()).hexdigest()==digest,'Offline database catalogue changed'
    assert set(expected['databases'])<= {'mirror','verify'}
    return row

original=json.loads((OUT/'volume-cleanup-result.json').read_text())
reviewed=original['preserved'];assert {row['name'] for row in reviewed}==EXPECTED
before=containers();assert {row['Name'].lstrip('/') for row in before}==PRODUCTION
beforeIdentities=sorted((identity(row) for row in before),key=lambda row:row['name'])
namedBefore={name:volume(name) for name in docker('volume','ls','-q').decode().splitlines() if name.startswith('mbbs-operator-app')}
assert len(namedBefore)==6
for expected in reviewed:validate(expected)
(OUT/'remaining-volume-cleanup-plan.json').write_text(json.dumps({'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'authorization':'User follow-up: please remove excessive test database volumes','volumes':reviewed,'productionContainers':beforeIdentities,'protectedNamedVolumes':sorted(namedBefore)},indent=2)+'\n')
removed=[]
try:
    for expected in reviewed:
        validate(expected)
        subprocess.run(['docker','volume','rm',expected['name']],check=True,stdout=subprocess.DEVNULL)
        removed.append(expected['name'])
finally:
    (OUT/'remaining-volume-removal-progress.json').write_text(json.dumps({'removed':removed},indent=2)+'\n')
    for flags,name in [(['ps'],'remaining-final-docker-ps.log'),(['ps','-a'],'remaining-final-docker-ps-a.log')]:
        body=docker(*flags,'--format','{{.Names}} {{.Status}}').decode();(OUT/name).write_text(body)
        assert {line.split()[0] for line in body.splitlines()}==PRODUCTION
assert sorted((identity(row) for row in containers()),key=lambda row:row['name'])==beforeIdentities
remaining=set(docker('volume','ls','-q').decode().splitlines())
assert not EXPECTED&remaining
assert remaining==set(namedBefore),'Only named production and rollback volumes should remain'
for name,expected in namedBefore.items():assert volume(name)==expected
backupAudit=json.loads((OUT/'final-audit.json').read_text())
backupRoot=Path('/home/ubuntu/apps/operatorApp/backups')
assert {str(p) for p in backupRoot.rglob('*.dump') if p.is_file() and not p.is_symlink()}=={row['path'] for row in backupAudit['fullBackupsKept']}
for row in backupAudit['fullBackupsKept']:
    path=Path(row['path']);assert path.stat().st_size==row['bytes']
    with path.open('rb') as stream:assert hashlib.file_digest(stream,'sha256').hexdigest()==row['sha256']
health=json.loads(docker('exec','mbbs-operator-app-app-1','node','-e',"fetch('http://127.0.0.1:3000/health').then(async r=>{if(!r.ok)process.exit(1);console.log(JSON.stringify(await r.json()))})"))
assert health['ok']
app=json.loads(docker('inspect','mbbs-operator-app-app-1'))[0]
assert app['State']['Running'] and app['State']['Health']['Status']=='healthy' and app['RestartCount']==0
result={'passed':True,'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'removedVolumes':removed,'removedCount':len(removed),'allocatedBytesRemoved':sum(row['allocatedBytes'] for row in reviewed),'remainingAnonymousDatabaseVolumes':0,'protectedNamedVolumes':sorted(namedBefore),'productionIdentitiesUnchanged':True,'productionHealthy':True,'latestFiveBackupHashesUnchanged':True}
(OUT/'remaining-volume-cleanup-result.json').write_text(json.dumps(result,indent=2)+'\n')
with (OUT/'EVIDENCE.md').open('a') as stream:stream.write('\nFollow-up '+result['at']+': the user requested removal of the remaining excess database volumes. Removed the three previously preserved detached anonymous volumes holding mirror/verify databases after exact identity, offline catalogue hash and zero-attachment checks. No anonymous database volumes remain. The six named production and V2 rollback volumes and all four production container identities/mounts are unchanged. Production health passes; all five retained full-backup hashes match. Released '+str(result['allocatedBytesRemoved'])+' allocated bytes. See remaining-volume-cleanup-plan.json and remaining-volume-cleanup-result.json; earlier records above describe the state before this follow-up.\n')
print(json.dumps(result))
