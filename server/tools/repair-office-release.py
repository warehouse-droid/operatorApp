#!/usr/bin/env python3
"""Release only the requested merged Repair office portal and notification layout."""
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
OUT=scope['SERVER']/'deployments/repair-office-merge-20261027'
NEW=[]
FILES=json.loads((OUT/'scope-files.json').read_text())+NEW
scope.update(OUT=OUT,FILES=FILES,IMAGE='mbbs-operator-app:repair-office-merge-20261027',ROLLBACK='mbbs-operator-app:repair-office-merge-rollback-20261027')


def prepare():
    release['prepare']()
    prepared=json.loads((OUT/'prepared.json').read_text())
    if (OUT/'pinned-before').exists():
        # Preserve only the previously validated Repair delta during a concurrent release.
        patch=[];conflicts=[]
        for name in FILES:
            live=(OUT/'live-before'/name).read_bytes()
            content=base['merge'](live,(OUT/'pinned-before'/name).read_bytes(),
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
            'run','--root','/tmp','--',sys.executable,__file__,'validate'],check=True)
        return
    prepared=base['ensure_sources']()
    artifacts=Path(os.environ['MBBS_TEST_ARTIFACT_DIR'])
    env=dict(os.environ,REPAIR_TEST_RUNTIME=str(OUT/'candidate'),REPAIR_TEST_DIFF=str(OUT/'release.patch'))
    log=artifacts/'repair-portal.log'
    with log.open('w') as output:
        result=subprocess.run(['bash','docker/run-repair-tests.sh','--source','node','tools/repair-office-checks.mjs'],
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
        for path in ['/repair/','/repair/office?source=office-merge','/repair/workshop','/repair/requester.html','/repair/team.webmanifest',
                     '/repair/offline.html','/repair/entry.js?v=20261027-office-merge','/repair/app.js?v=20261027-office-merge','/repair/repair.css?v=20261027-office-merge','/api/repair/availability']:
            request=urllib.request.Request(origin+path,headers={'User-Agent':'Mozilla/5.0','Cache-Control':'no-cache'})
            with urllib.request.urlopen(request,timeout=20) as response:
                content=response.read();assert response.status==200
                if path.startswith('/repair/office'):
                    assert '/repair/office' not in response.geturl() and response.geturl().endswith('?source=office-merge')
                if path.endswith('/availability'):assert json.loads(content)['enabled'] is True
                if any(path.startswith('/repair/'+name) for name in ['entry.js','app.js','repair.css']):assert hashlib.sha256(content).hexdigest()==prepared['sourceHashes']['public'+path.split('?')[0]]
                checks.append({'url':origin+path,'status':response.status})
    base['save'](OUT/'live-verification.json',{'sourceHashesVerified':True,'healthy':True,'http':checks})
    print(json.dumps({'liveVerification':'passed','files':len(FILES),'httpChecks':len(checks)}))

def deploy():
    active=base['db']("SELECT (SELECT count(*) FROM operator_netsuite_posting_commands WHERE status IN ('queued','posting','finalizing'))+(SELECT count(*) FROM driver_foreground_action_receipts WHERE status='executing')+(SELECT count(*) FROM regular_stock_delivery_operations WHERE status IN ('queued','running'))+(SELECT count(*) FROM regular_stock_handoffs WHERE status='executing')+(SELECT count(*) FROM scm_smart_proposals WHERE status='executing');")
    assert active=='0','Wait for active operations: '+active
    base['deploy']()

scope['verify']=verify
if __name__=='__main__':
    {'prepare':prepare,'validate':validate,'build':base['build'],'deploy':deploy,'verify':verify}[sys.argv[1]]()
