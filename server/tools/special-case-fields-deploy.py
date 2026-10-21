"""Publish a guarded app-only overlay with a transaction-scoped price-basis migration."""
import datetime
import difflib
import importlib.util
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tarfile

SERVER=Path(__file__).resolve().parents[1]
ROOT=Path(os.environ.get('OPERATOR_APP_ROOT',str(SERVER.parent)))
spec=importlib.util.spec_from_file_location('fields_release_core',SERVER/'tools/special-stock-updates-deploy.py')
release=importlib.util.module_from_spec(spec);spec.loader.exec_module(release)
release.SERVER=SERVER
release.ROOT=ROOT
release.RELEASE=SERVER/'deployments/special-case-fields-20261003'
release.EVIDENCE=SERVER/'test-artifacts/special-case-fields-20261003'
release.FILES=json.loads((SERVER/'tools/special-case-fields-files.json').read_text())
release.CONTAINERS={'app':'mbbs-operator-app-app-1'}
release.DEPENDENCIES=['mbbs-operator-app-db-1','mbbs-operator-app-ollama-1','mbbs-operator-app-webhook-worker-1']
release.MIGRATION='264_special_case_field_edits.sql'
release.core.RELEASE=release.RELEASE
release.core.CONTAINERS=release.CONTAINERS
release.core.ROOT=ROOT
release.core.core.ROOT=ROOT
release.core.core.SERVER=ROOT/'server'
docker,save,state=release.docker,release.save,release.state

def capture():
    os.umask(0o077)
    release.RELEASE.mkdir(exist_ok=False,parents=True)
    before=release.metadata(release.CONTAINERS['app'])
    baseline=release.RELEASE/'before-app';baseline.mkdir()
    for path in ['src','public','migrations','package.json','package-lock.json']:
        with tarfile.open(fileobj=io.BytesIO(docker('cp',release.CONTAINERS['app']+':/app/'+path,'-'))) as archive:
            archive.extractall(baseline,filter='data')
    assert release.metadata(release.CONTAINERS['app'])==before
    candidate=release.RELEASE/'candidate-app';shutil.copytree(baseline,candidate)
    changes=''
    for file in release.FILES:
        old=baseline/file;base=release.EVIDENCE/'before'/file;source=SERVER/file
        # Candidate SCM HTML already retains the live page; the only task delta is its script cache key.
        if file=='public/scm-stock-requests.html':
            text=old.read_text();assert 'lineFields=20261003-v1' not in text
            import re
            text,count=re.subn(r'(scm-special-stock-requests\.js\?[^"\n]+)(")',r'\1&lineFields=20261003-v1\2',text);assert count==1
        elif not base.exists():
            assert not old.exists(),'New source already exists: '+file
            text=source.read_text()
        elif old.read_bytes()==base.read_bytes():text=source.read_text()
        else:
            merged=subprocess.run(['git','merge-file','-p',str(source),str(base),str(old)],text=True,capture_output=True)
            assert merged.returncode==0,'Resolve live drift: '+file
            text=merged.stdout
        target=candidate/file;target.parent.mkdir(parents=True,exist_ok=True);target.write_text(text)
        changes+=''.join(difflib.unified_diff(old.read_text().splitlines(True) if old.exists() else [],text.splitlines(True),fromfile='a/'+file,tofile='b/'+file))
    tree=release.core.files_at(candidate);oldTree=release.core.files_at(baseline)
    changed=sorted(file for file in tree if tree[file]!=oldTree.get(file))
    assert set(changed)==set(release.FILES)
    (release.RELEASE/'app.patch').write_text(changes)
    save('app-source-tree.json',tree)
    data={'services':{'app':{'before':before,'image':'mbbs-operator-app:special-case-fields-20261003','files':release.FILES,
        'sourceHashes':{file:tree[file] for file in release.FILES},'changedFiles':changed}},
        'dependencies':{name:release.metadata(name) for name in release.DEPENDENCIES},
        'workspaceHashes':{file:release.digest((SERVER/file).read_bytes()) for file in release.FILES}}
    save('manifest.json',data);release.current(data)
    print(json.dumps({'captured':True,'sourceMatchesTested':all(tree[file]==release.digest((SERVER/file).read_bytes()) for file in release.FILES),'changedFiles':changed}),flush=True)

def checks(data):
    for file in ['static.json','focused.json','tests.json','mutations.json','supplement.json','changed-lines.json']:
        evidence=json.loads((release.EVIDENCE/file).read_text())
        assert evidence['sourceHashes']==data['services']['app']['sourceHashes'],file+' source mismatch'
        assert not evidence.get('newFailures'),file+' regressions'
        assert evidence.get('counts',{}).get('fail',0)==0 or file=='tests.json'
        if file=='mutations.json':assert evidence['killed']==evidence['total'] and evidence['total']>=3
        if file=='changed-lines.json':assert not evidence['uncovered']

def verify():
    data=state();row=data['services']['app']
    release.core.core.ready(row['candidateImageId'])
    actual=release.metadata(release.CONTAINERS['app'])
    assert actual['imageId']==row['candidateImageId']
    assert actual['configuration']==row['before']['configuration']
    assert json.loads(docker('exec',release.CONTAINERS['app'],'node','-e',release.TREE))==json.loads((release.RELEASE/'app-source-tree.json').read_text())
    assert {name:release.metadata(name) for name in release.DEPENDENCIES}==data['dependencies']
    assert release.database("SELECT count(*) FROM schema_migrations WHERE filename='"+release.MIGRATION+"'")=='1'
    script=(SERVER/'tools/special-case-fields-live.mjs').read_text()
    live=json.loads(docker('exec','-i',release.CONTAINERS['app'],'node','--input-type=module',input=script.encode()))
    result={'deployed':True,'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'appImage':row['candidateImageId'],
      'onlyAppChanged':True,'configurationPreserved':True,'migration':release.MIGRATION,**live}
    save('result.json',result);print(json.dumps(result),flush=True)

def apply():
    data=state();release.current(data);checks(data);release.core.config_check(data)
    active=release.active_work();save('active-before.json',active);assert not any(active.values()),'Wait for active operations: '+json.dumps(active)
    rollback=release.database("SELECT pg_get_functiondef('preserve_special_original_price()'::regprocedure)")
    (release.RELEASE/'migration.rollback.sql').write_text(rollback+'\n')
    applied=False
    try:
        if release.database("SELECT count(*) FROM schema_migrations WHERE filename='"+release.MIGRATION+"'")=='0':
            sql=(release.RELEASE/'candidate-app/migrations'/release.MIGRATION).read_text()
            release.database("BEGIN;SET LOCAL lock_timeout='5s';SET LOCAL statement_timeout='30s';\n"+sql+
                "\nINSERT INTO schema_migrations(filename) VALUES('"+release.MIGRATION+"');COMMIT;")
            applied=True
            save('migration-result.json',{'applied':True,'rowDataChanged':False})
        with (release.RELEASE/'publish.log').open('wb') as log:
            subprocess.run(release.core.compose(data)+['up','-d','--no-build','--no-deps','--pull','never','app'],cwd=ROOT,stdout=log,stderr=subprocess.STDOUT,check=True,timeout=60)
        verify()
    except Exception:
        with (release.RELEASE/'rollback.log').open('wb') as log:
            subprocess.run(release.core.compose(data,'compose.rollback.yml')+['up','-d','--no-build','--no-deps','--pull','never','app'],cwd=ROOT,stdout=log,stderr=subprocess.STDOUT,check=True,timeout=60)
        if applied:release.database("BEGIN;SET LOCAL lock_timeout='5s';\n"+rollback+"\nDELETE FROM schema_migrations WHERE filename='"+release.MIGRATION+"';COMMIT;")
        save('rollback-result.json',{'previousAppAndTriggerRestored':True});raise

if __name__=='__main__':
    {'capture':capture,'prepare':release.prepare,'apply':apply,'verify':verify}[sys.argv[1]]()
