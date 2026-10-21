"""Audit offline anonymous volumes and remove only reviewed test/empty volumes."""
import hashlib,json,os,re,stat,struct,subprocess,sys
from pathlib import Path

OUT=Path('/home/ubuntu/apps/operatorApp/server/test-artifacts/host-backup-audit-20261006')
STANDARD={'postgres','template0','template1','UTF8','utf8'}
TEST_NAME=re.compile(r'^(mbt_[A-Za-z0-9_-]+|mbbs_harness|fleet_(test|status)|(mirror|retention|source|v2)_check)$')

def inspect_volumes():
    names=subprocess.check_output(['docker','volume','ls','-q'],text=True).splitlines()
    return json.loads(subprocess.check_output(['docker','volume','inspect',*names])) if names else []

def attached():
    ids=subprocess.check_output(['docker','ps','-aq'],text=True).splitlines()
    rows=json.loads(subprocess.check_output(['docker','inspect',*ids])) if ids else []
    return {mount['Name'] for row in rows for mount in row.get('Mounts',[]) if mount['Type']=='volume'}

def describe(row):
    root=Path(row['Mountpoint']);count=logical=allocated=0;databases=set();catalogHashes={}
    for folder,dirs,files in os.walk(root,followlinks=False):
        dirs[:]=[name for name in dirs if not (Path(folder)/name).is_symlink()]
        for name in files:
            s=(Path(folder)/name).lstat()
            if stat.S_ISREG(s.st_mode):count+=1;logical+=s.st_size;allocated+=s.st_blocks*512
    for cluster in [root,root/'18/docker']:
        mapping=cluster/'global/pg_filenode.map'
        if not (cluster/'PG_VERSION').is_file() or not mapping.is_file():continue
        body=mapping.read_bytes();magic,n=struct.unpack_from('<II',body);assert n<=64
        for i in range(n):
            oid,filenode=struct.unpack_from('<II',body,8+i*8)
            if oid!=1262:continue
            catalog=cluster/'global'/str(filenode);contents=catalog.read_bytes()
            catalogHashes[str(catalog.relative_to(root))]=hashlib.sha256(contents).hexdigest()
            databases.update(x.rstrip(b'\x00').decode() for x in re.findall(rb'(?<![A-Za-z0-9_-])[A-Za-z][A-Za-z0-9_-]{2,62}\x00',contents))
    databases-=STANDARD
    reason='empty' if count==0 else 'test database catalogue' if databases and all(TEST_NAME.fullmatch(name) for name in databases) else 'unclassified historic database; preserve'
    return {'name':row['Name'],'createdAt':row.get('CreatedAt'),'labels':row.get('Labels') or {},'files':count,'logicalBytes':logical,'allocatedBytes':allocated,'databases':sorted(databases),'catalogHashes':catalogHashes,'reason':reason}

if sys.argv[1]=='audit':
    used=attached()
    rows=[describe(row) for row in inspect_volumes() if re.fullmatch('[0-9a-f]{64}',row['Name']) and row['Name'] not in used and set(row.get('Labels') or {})=={'com.docker.volume.anonymous'}]
    plan={'candidates':[row for row in rows if row['reason'] in ['empty','test database catalogue']],'preserved':[row for row in rows if row['reason'].startswith('unclassified')]}
    target=OUT/'volume-cleanup-plan.json'
    if target.exists():target=OUT/('volume-inventory-'+str(__import__('time').time_ns())+'.json')
    target.write_text(json.dumps(plan,indent=2)+'\n')
    print(json.dumps({'removableVolumes':len(plan['candidates']),'testDatabases':sum(row['reason']=='test database catalogue' for row in plan['candidates']),'emptyVolumes':sum(row['reason']=='empty' for row in plan['candidates']),'allocatedBytes':sum(row['allocatedBytes'] for row in plan['candidates']),'preserved':plan['preserved']}))
elif sys.argv[1]=='apply':
    plan=json.loads((OUT/'volume-cleanup-plan.json').read_text());removed=[]
    try:
        for expected in plan['candidates']:
            assert expected['name'] not in attached()
            row=json.loads(subprocess.check_output(['docker','volume','inspect',expected['name']]))[0]
            assert set(row.get('Labels') or {})=={'com.docker.volume.anonymous'}
            assert describe(row)==expected,'Volume changed since review'
            subprocess.run(['docker','volume','rm',expected['name']],check=True,stdout=subprocess.DEVNULL)
            removed.append(expected['name'])
    finally:
        (OUT/'volume-cleanup-result.json').write_text(json.dumps({'removed':removed,'removedCount':len(removed),'allocatedBytesRemoved':sum(row['allocatedBytes'] for row in plan['candidates'] if row['name'] in removed),'preserved':plan['preserved']},indent=2)+'\n')
        for flags,name in [(['ps'],'volume-docker-ps.log'),(['ps','-a'],'volume-docker-ps-a.log')]:
            (OUT/name).write_bytes(subprocess.check_output(['docker',*flags,'--format','{{.Names}} {{.Status}}']))
    print(json.dumps({'removedVolumes':len(removed),'preservedHistoricVolumes':len(plan['preserved'])}))
else:raise SystemExit('Use audit or apply')
