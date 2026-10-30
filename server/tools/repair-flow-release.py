#!/usr/bin/env python3
"""Release only the requested Repair request, job and local purchase-order workflow."""
import json
import difflib
import os
import re
import runpy
import subprocess
import sys
import urllib.request
from pathlib import Path

release=runpy.run_path(str(Path(__file__).with_name('bin-final-collection-release.py')))
base,scope=release['base'],release['scope']
OUT=scope['SERVER']/'deployments/repair-job-flow-20261027'
NEW=['src/repair/purchase-orders.js','public/repair/job-parts.js','public/repair/intake.js','migrations/316_repair_local_purchase_orders.sql','migrations/317_repair_quote_scopes.sql','migrations/318_repair_work_jobs.sql','src/repair/jobs.js']
FILES=json.loads((OUT/'scope-files.json').read_text())+NEW
scope.update(OUT=OUT,FILES=FILES,IMAGE='mbbs-operator-app:repair-job-flow-20261027',ROLLBACK='mbbs-operator-app:repair-job-flow-rollback-20261027')


def prepare():
    release['prepare']()
    prepared=json.loads((OUT/'prepared.json').read_text())
    if (OUT/'pinned-before').exists():
        # Preserve only the previously validated Repair delta during a concurrent release.
        patch=[];conflicts=[]
        for name in FILES:
            live=(OUT/'live-before'/name).read_bytes() if (OUT/'live-before'/name).exists() else b''
            content=base['merge'](live,(OUT/'pinned-before'/name).read_bytes() if (OUT/'pinned-before'/name).exists() else b'',
                (OUT/'pinned-after'/name).read_bytes(),name,'office-rebase')
            if b'<<<<<<< ' in content:conflicts.append(name)
            (OUT/'candidate'/name).write_bytes(content)
            patch.extend(difflib.unified_diff(live.decode().splitlines(True),content.decode().splitlines(True),
                fromfile='live/'+name,tofile='candidate/'+name))
        (OUT/'release.patch').write_text(''.join(patch))
        prepared['conflicts']=conflicts
        prepared['sourceHashes']={name:base['sha'](OUT/'candidate'/name) for name in FILES}
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
            'run','--root','/tmp','--','env','REPAIR_FLOW_PREVIEW='+os.environ.get('REPAIR_FLOW_PREVIEW',''),sys.executable,__file__,'validate'],check=True)
        return
    prepared=base['ensure_sources']()
    artifacts=Path(os.environ['MBBS_TEST_ARTIFACT_DIR'])
    env=dict(os.environ,REPAIR_TEST_RUNTIME=str(OUT/'candidate'),REPAIR_TEST_DIFF=str(OUT/'release.patch'))
    log=artifacts/'repair-portal.log'
    with log.open('w') as output:
        result=subprocess.run(['bash','docker/run-repair-tests.sh','--source','node','tools/repair-flow-checks.mjs'],
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
        for path in ['/repair/','/repair/office?source=job-flow','/repair/workshop','/repair/requester.html','/repair/team.webmanifest',
                     '/repair/offline.html','/repair/entry.js?v=20261027-flow','/repair/app.js?v=20261027-flow','/repair/repair.css?v=20261027-flow','/api/repair/availability']:
            request=urllib.request.Request(origin+path,headers={'User-Agent':'Mozilla/5.0','Cache-Control':'no-cache'})
            with urllib.request.urlopen(request,timeout=20) as response:
                content=response.read();assert response.status==200
                if path.startswith('/repair/office'):
                    assert '/repair/office' not in response.geturl() and response.geturl().endswith('?source=job-flow')
                if path.endswith('/availability'):assert json.loads(content)['enabled'] is True
                if any(path.startswith('/repair/'+name) for name in ['entry.js','app.js','repair.css']):assert hashlib.sha256(content).hexdigest()==prepared['sourceHashes']['public'+path.split('?')[0]]
                checks.append({'url':origin+path,'status':response.status})
    base['save'](OUT/'live-verification.json',{'sourceHashesVerified':True,'healthy':True,'http':checks})
    print(json.dumps({'liveVerification':'passed','files':len(FILES),'httpChecks':len(checks)}))

def deploy():
    active=base['db']("SELECT (SELECT count(*) FROM operator_netsuite_posting_commands WHERE status IN ('queued','posting','finalizing'))+(SELECT count(*) FROM driver_foreground_action_receipts WHERE status='executing')+(SELECT count(*) FROM regular_stock_delivery_operations WHERE status IN ('queued','running'))+(SELECT count(*) FROM regular_stock_handoffs WHERE status='executing')+(SELECT count(*) FROM scm_smart_proposals WHERE status='executing');")
    assert active=='0','Wait for active operations: '+active
    assert base['db']("SELECT count(*) FROM repair_postings WHERE state='working';")=='0','Wait for active Repair posting'
    captured=json.loads((OUT/'capture.json').read_text())
    assert {key:base['metadata'](name) for key,name in base['SERVICES'].items()}==captured,'Live changed before maintenance'
    # Drain the application before backfill so the old version cannot write rows
    # between the hierarchy migration and the replacement application's startup.
    base['docker']('stop','--time','30',base['APP'])
    base['save'](OUT/'maintenance-audit.json',{'applicationDrainedBeforeMigration':True,'otherServicesStopped':False})
    try:base['deploy']()
    finally:
        if base['docker']('inspect','--format','{{.State.Running}}',base['APP'])=='false':
            base['docker']('start',base['APP'])
            assert base['health'](),'Application failed to restart after deployment attempt'


def apply_migration():
    names=['316_repair_local_purchase_orders.sql','317_repair_quote_scopes.sql','318_repair_work_jobs.sql']
    pending=[name for name in names if not base['db']("SELECT filename FROM schema_migrations WHERE filename='"+name+"';")]
    if not pending:return {'filenames':names,'alreadyApplied':True}
    if names[0] in pending:assert base['db']("SELECT count(*) FROM repair_purchases WHERE btrim(invoice_ref)='';")=='0','Review existing uninvoiced purchases before migration'
    target=OUT/'repair-before-hierarchy.dump'
    if not target.exists():
        with target.open('xb') as output:
            target.chmod(0o600)
            subprocess.run(['sudo','-n','docker','exec',base['SERVICES']['db'],'sh','-c',
                'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc -t "public.repair_*" -t public.schema_migrations'],check=True,stdout=output)
    listing=base['docker']('exec','-i',base['SERVICES']['db'],'pg_restore','--list',data=target.read_bytes())
    assert all(table in listing for table in ['TABLE DATA public repair_purchases','TABLE DATA public repair_purchase_lines','TABLE DATA public repair_requests','TABLE DATA public repair_quotes','TABLE DATA public schema_migrations'])
    sql="BEGIN; SET LOCAL lock_timeout='10s'; SET LOCAL statement_timeout='60s';\n"
    for name in pending:sql+=(OUT/'candidate/migrations'/name).read_text()+"\nINSERT INTO schema_migrations(filename) VALUES ('"+name+"');\n"
    base['db'](sql+'COMMIT;')
    return {'filenames':pending,'applied':True,'sourceHashes':{name:base['sha'](OUT/'candidate/migrations'/name) for name in pending},'backupSha256':base['sha'](target)}

scope['apply_migration']=apply_migration
scope['verify']=verify
if __name__=='__main__':
    {'prepare':prepare,'validate':validate,'build':base['build'],'deploy':deploy,'verify':verify}[sys.argv[1]]()
