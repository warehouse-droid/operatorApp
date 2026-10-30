#!/usr/bin/env python3
"""Release only the requested Repair portal/requester/PWA changes."""
import json
import os
import re
import runpy
import subprocess
import sys
import urllib.request
from pathlib import Path

release=runpy.run_path(str(Path(__file__).with_name('bin-final-collection-release.py')))
base,scope=release['base'],release['scope']
OUT=scope['SERVER']/'deployments/repair-portal-20261027'
NEW=['public/repair/requester.html','public/repair/requester.js','public/repair/requester.css',
     'public/repair/requester-embed.js','public/repair/team.webmanifest','public/repair/offline.html',
     'src/repair/master-records.js','migrations/313_repair_equipment_masters.sql']
FILES=json.loads((OUT/'scope-files.json').read_text())+NEW
scope.update(OUT=OUT,FILES=FILES,IMAGE='mbbs-operator-app:repair-portal-20261027',ROLLBACK='mbbs-operator-app:repair-portal-rollback-20261027')

original_merge=base['merge']
def merge(live,before,after,file,stage):
    # Cache identifiers have advanced independently since the workspace copy.
    # Apply this release's exact HTML/cache edits to the captured live bytes.
    if file.endswith('.html') and file!='public/repair/index.html':
        content=live.decode()
        if 'app-sidebar.js' in content:
            content=re.sub(r'/app-sidebar\.js(?:\?[^"\s<>]*)?',
                lambda m:m.group()+('&' if '?' in m.group() else '?')+'repairNav=20261027-v2',content)
        if file in ['public/operator.html','public/driver.html']:
            asset='operator.js' if 'operator' in file else 'driver.js'
            content=re.sub(r'/'+re.escape(asset)+r'\?[^"\s]+',lambda m:m.group()+'&repairPortal=20261027',content)
            content=content.replace('  </body>','    <script src="/repair/requester-embed.js?v=20261027-v1"></script>\n  </body>')
        return content.encode()
    if file in ['public/service-worker.js','public/driver-service-worker.js']:
        operator=file=='public/service-worker.js'
        html=(OUT/'live-before/public'/('operator.html' if operator else 'driver.html')).read_text()
        pattern=r'/'+('operator' if operator else 'driver')+r'\.js\?[^"\s]+'
        asset=re.search(pattern,html).group()+'&repairPortal=20261027'
        content,count=re.subn(pattern,lambda _:asset,live.decode());assert count==1
        anchor='  "/manifest.webmanifest",' if operator else '  "/driver",'
        assert content.count(anchor)==1
        content=content.replace(anchor,anchor+'\n  "/repair/requester-embed.js?v=20261027-v1",',1)
        if operator:content=re.sub(r'const CACHE_NAME = "[^"]+";','const CACHE_NAME = "mbbs-yard-operator-20261027-repair-portal";',content)
        else:content=content.replace('${DRIVER_CACHE_PREFIX}v52','${DRIVER_CACHE_PREFIX}v53').replace('${DRIVER_CACHE_PREFIX}refresh-v52','${DRIVER_CACHE_PREFIX}refresh-v53')
        return content.encode()
    return original_merge(live,before,after,file,stage)
base['merge']=merge

def prepare():
    release['prepare']()
    prepared=json.loads((OUT/'prepared.json').read_text())
    assert not prepared['conflicts'],prepared['conflicts']
    # Some HTML consumers can already contain the new cache key after a rebase.
    unchanged=[name for name in FILES if (OUT/'live-before'/name).exists()
        and base['sha'](OUT/'live-before'/name)==base['sha'](OUT/'candidate'/name)]
    prepared['unchangedFiles']=unchanged
    base['save'](OUT/'prepared.json',prepared)
    for folder in ['candidate','live-before']:
        for path in [OUT/folder,*(OUT/folder).rglob('*')]:path.chmod(0o755 if path.is_dir() else 0o644)

def validate():
    if not os.environ.get('MBBS_TEST_ARTIFACT_DIR'):
        subprocess.run(['sudo','-n','python3',str(scope['SERVER'].parent/'docker/retention/retention.py'),
            'run','--root','/tmp','--',sys.executable,__file__,'validate'],check=True)
        return
    prepared=base['ensure_sources']()
    artifacts=Path(os.environ['MBBS_TEST_ARTIFACT_DIR'])
    env=dict(os.environ,REPAIR_TEST_RUNTIME=str(OUT/'candidate'),REPAIR_TEST_DIFF=str(OUT/'release.patch'))
    log=artifacts/'repair-portal.log'
    with log.open('w') as output:
        result=subprocess.run(['bash','docker/run-repair-tests.sh','--source','node','tools/repair-gauntlet.mjs'],
            cwd=scope['SERVER'].parent,env=env,stdout=output,stderr=subprocess.STDOUT)
    content=log.read_text();checks=[]
    for line in content.splitlines():
        try:value=json.loads(line)
        except ValueError:continue
        if isinstance(value,dict):checks.append(value);print(json.dumps(value),flush=True)
    if result.returncode:print(content[-16000:])
    assert result.returncode==0,'Repair portal candidate failed validation'
    assert base['ensure_sources']()==prepared
    base['save'](OUT/'validation.json',{'passed':True,'sourceHashes':prepared['sourceHashes'],
        'checks':checks,'cleanupVerified':True})

def verify():
    import hashlib
    prepared=base['ensure_sources']()
    for name,expected in prepared['sourceHashes'].items():
        assert base['docker']('exec',base['APP'],'sha256sum','/app/'+name).split()[0]==expected,name
    assert base['health']()
    checks=[]
    for origin in ['http://127.0.0.1:3000','https://test.mbbsoperation.com']:
        for path in ['/repair/','/repair/office','/repair/workshop','/repair/requester.html','/repair/team.webmanifest',
                     '/repair/offline.html','/app-sidebar.js?repairNav=20261027-v2','/api/repair/availability']:
            request=urllib.request.Request(origin+path,headers={'User-Agent':'Mozilla/5.0','Cache-Control':'no-cache'})
            with urllib.request.urlopen(request,timeout=20) as response:
                content=response.read();assert response.status==200
                if path.endswith('/availability'):assert json.loads(content)['enabled'] is True
                if path.startswith('/app-sidebar.js'):assert hashlib.sha256(content).hexdigest()==prepared['sourceHashes']['public/app-sidebar.js']
                checks.append({'url':origin+path,'status':response.status})
    base['save'](OUT/'live-verification.json',{'sourceHashesVerified':True,'healthy':True,'http':checks})
    print(json.dumps({'liveVerification':'passed','files':len(FILES),'httpChecks':len(checks)}))

def deploy():
    active=base['db']("SELECT (SELECT count(*) FROM operator_netsuite_posting_commands WHERE status IN ('queued','posting','finalizing'))+(SELECT count(*) FROM driver_foreground_action_receipts WHERE status='executing')+(SELECT count(*) FROM regular_stock_delivery_operations WHERE status IN ('queued','running'))+(SELECT count(*) FROM regular_stock_handoffs WHERE status='executing')+(SELECT count(*) FROM scm_smart_proposals WHERE status='executing');")
    assert active=='0','Wait for active operations: '+active
    base['deploy']()

def apply_migration():
    name='313_repair_equipment_masters.sql'
    if base['db']("SELECT filename FROM schema_migrations WHERE filename='"+name+"';"):
        return {'filename':name,'alreadyApplied':True}
    # Only the Repair directory and its settings are affected. Keep a rollback copy.
    target=OUT/'repair-directory-before.dump'
    if not target.exists():
        with target.open('xb') as output:
            target.chmod(0o600)
            subprocess.run(['sudo','-n','docker','exec',base['SERVICES']['db'],'sh','-c',
                'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc -t public.repair_vehicles -t public.repair_settings -t public.schema_migrations'],check=True,stdout=output)
    listing=base['docker']('exec','-i',base['SERVICES']['db'],'pg_restore','--list',data=target.read_bytes())
    assert all(name in listing for name in ['TABLE DATA public repair_vehicles','TABLE DATA public repair_settings','TABLE DATA public schema_migrations'])
    sql=(OUT/'candidate/migrations'/name).read_text()
    base['db']("BEGIN; SET LOCAL lock_timeout='10s'; SET LOCAL statement_timeout='60s';\n"+sql+
        "\nINSERT INTO schema_migrations(filename) VALUES ('"+name+"'); COMMIT;")
    return {'filename':name,'applied':True,'sha256':base['sha'](OUT/'candidate/migrations'/name)}

scope['apply_migration']=apply_migration
scope['verify']=verify
if __name__=='__main__':
    {'prepare':prepare,'validate':validate,'build':base['build'],'deploy':deploy,'verify':verify}[sys.argv[1]]()
