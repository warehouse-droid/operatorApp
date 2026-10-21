"""Read-only catalog validation of the six existing full-backup candidates."""
import hashlib,json,subprocess
from pathlib import Path

ROOT=Path('/home/ubuntu/apps/operatorApp/backups')
OUT=Path('/home/ubuntu/apps/operatorApp/server/test-artifacts/host-backup-audit-20261006')
NAME='mbbs-backup-audit-reader-20261006'
files=sorted(ROOT.rglob('*.dump'))
assert len(files)>=5 and all(p.is_file() and not p.is_symlink() and p.stat().st_size>0 for p in files)
assert not subprocess.check_output(['docker','ps','-a','--filter','name=^/'+NAME+'$','--format','{{.ID}}']).strip()
image=json.loads(subprocess.check_output(['docker','inspect','mbbs-operator-app-db-1']))[0]['Image']
script='for file do printf "CATALOG_FILE %s\\n" "$file"; pg_restore --list "$file" || exit; done'
args=['docker','run','--rm','--name',NAME,'--init','--network','none','--read-only','--label','com.mbbs.lifecycle=disposable-test','--cgroup-parent=mbbs-tests.slice','--memory=256m','--memory-swap=256m','--cpus=0.5','--pids-limit=64','--tmpfs','/tmp:mode=1777,size=16m','--mount','type=bind,src='+str(ROOT)+',dst=/backups,readonly','--user','0','--entrypoint','sh',image,'-c',script,'_',*['/backups/'+str(p.relative_to(ROOT)) for p in files]]
try:
    result=subprocess.run(args,capture_output=True,text=True,timeout=120,check=True)
    (OUT/'backup-catalogues.log').write_text(result.stdout)
    rows=[]
    for section in result.stdout.split('CATALOG_FILE ')[1:]:
        name,body=section.split('\n',1);path=ROOT/name.removeprefix('/backups/')
        data=[line for line in body.splitlines() if ' TABLE DATA ' in line]
        tables={line.split(' TABLE DATA ',1)[1].split()[1] for line in data}
        required={'operators','inventory_items','sales_orders'}
        assert required<=tables,(str(path),sorted(tables))
        stat=path.stat();digest=hashlib.file_digest(path.open('rb'),'sha256').hexdigest()
        rows.append({'path':str(path),'bytes':stat.st_size,'mtimeNs':stat.st_mtime_ns,'sha256':digest,'dataTables':len(tables),'fullBackupCatalog':True})
    rows.sort(key=lambda row:(row['mtimeNs'],row['path']),reverse=True)
    (OUT/'full-backups-before.json').write_text(json.dumps(rows,indent=2)+'\n')
    print(json.dumps({'fullBackups':len(rows),'keepLatest':[r['path'] for r in rows[:5]],'removeOlder':[r['path'] for r in rows[5:]]}))
finally:
    subprocess.run(['docker','rm','-fv',NAME],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
    assert not subprocess.check_output(['docker','ps','-a','--filter','name=^/'+NAME+'$','--format','{{.ID}}']).strip()
    for flags,filename in [(['ps'],'catalog-docker-ps.log'),(['ps','-a'],'catalog-docker-ps-a.log')]:
        (OUT/filename).write_bytes(subprocess.check_output(['docker',*flags,'--format','{{.Names}} {{.Status}}']))
