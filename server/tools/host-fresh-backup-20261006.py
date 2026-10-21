"""Take one full online backup; failed exports never replace completed archives."""
import datetime,hashlib,json,os,subprocess
from pathlib import Path

root=Path('/home/ubuntu/apps/operatorApp/backups/production')
out=Path('/home/ubuntu/apps/operatorApp/server/test-artifacts/host-backup-audit-20261006')
assert root.is_dir() and not root.is_symlink()
stamp=datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
target=root/f'mbbs_yard_{stamp}.dump'
partial=target.with_suffix('.dump.partial')
assert not target.exists() and not partial.exists()
try:
    with partial.open('xb') as output:
        os.chmod(partial,0o600)
        process=subprocess.run(['docker','exec','mbbs-operator-app-db-1','pg_dump','--format=custom','--compress=6','--no-owner','--no-privileges','-U','mbbs_app','-d','mbbs_yard'],stdout=output,stderr=subprocess.PIPE,timeout=900)
        output.flush();os.fsync(output.fileno())
    assert process.returncode==0,process.stderr.decode()
    assert partial.stat().st_size>0
    with partial.open('rb') as source:assert source.read(5)==b'PGDMP'
    partial.rename(target)
    with target.open('rb') as source:digest=hashlib.file_digest(source,'sha256').hexdigest()
    result={'createdAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'path':str(target),'bytes':target.stat().st_size,'sha256':digest,'pgDumpExit':0,'type':'full database custom archive','restoreTested':False}
    (out/'fresh-backup.json').write_text(json.dumps(result,indent=2)+'\n')
    print(json.dumps(result))
finally:
    if partial.exists():partial.unlink()
