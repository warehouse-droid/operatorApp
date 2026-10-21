"""Release SCM line visibility, packing layout and required-date editing with rollback."""
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
spec=importlib.util.spec_from_file_location('uom_release_base',SERVER/'tools/special-case-fields-deploy.py')
base=importlib.util.module_from_spec(spec);spec.loader.exec_module(base)
release=base.release
release.RELEASE=SERVER/'deployments/special-scm-lines-20261003'
release.EVIDENCE=SERVER/'test-artifacts/special-scm-lines-20261003'
release.FILES=json.loads((SERVER/'tools/special-scm-lines-files.json').read_text())
release.core.RELEASE=release.RELEASE
docker,save,state=release.docker,release.save,release.state

def capture():
    os.umask(0o077);release.RELEASE.mkdir(parents=True,exist_ok=False)
    before=release.metadata(release.CONTAINERS['app'])
    old=release.RELEASE/'before-app';old.mkdir()
    for path in ['src','public','migrations','package.json','package-lock.json']:
        with tarfile.open(fileobj=io.BytesIO(docker('cp',release.CONTAINERS['app']+':/app/'+path,'-'))) as archive:archive.extractall(old,filter='data')
    assert release.metadata(release.CONTAINERS['app'])==before
    candidate=release.RELEASE/'candidate-app';shutil.copytree(old,candidate)
    patch=''
    for file in release.FILES:
        reference=release.EVIDENCE/'workspace-before'/file
        if reference.exists():
            merged=subprocess.run(['git','merge-file','-p',str(SERVER/file),str(reference),str(old/file)],text=True,capture_output=True)
            assert merged.returncode==0,'Live drift needs reconciliation: '+file
            content=merged.stdout
        else:
            assert not (old/file).exists(),'New file already exists: '+file
            content=(SERVER/file).read_text()
        (candidate/file).write_text(content)
        if (old/file).exists():
            target=release.EVIDENCE/'before'/file;target.parent.mkdir(parents=True,exist_ok=True);shutil.copy2(old/file,target)
        patch+=''.join(difflib.unified_diff((old/file).read_text().splitlines(True) if (old/file).exists() else [],content.splitlines(True),fromfile='a/'+file,tofile='b/'+file))
    tree=release.core.files_at(candidate);oldTree=release.core.files_at(old)
    changed=sorted(file for file in tree if tree[file]!=oldTree.get(file));assert set(changed)==set(release.FILES)
    (release.RELEASE/'app.patch').write_text(patch);save('app-source-tree.json',tree)
    save('manifest.json',{'services':{'app':{'before':before,'image':'mbbs-operator-app:special-scm-lines-20261003',
      'files':release.FILES,'sourceHashes':{file:tree[file] for file in release.FILES},'changedFiles':changed}},
      'dependencies':{name:release.metadata(name) for name in release.DEPENDENCIES},
      'workspaceHashes':{file:release.digest((SERVER/file).read_bytes()) for file in release.FILES}})
    release.current(state());print(json.dumps({'captured':True,'changedFiles':changed}),flush=True)

def verify():
    data=state();row=data['services']['app'];release.core.core.ready(row['candidateImageId'])
    actual=release.metadata(release.CONTAINERS['app'])
    assert actual['imageId']==row['candidateImageId'] and actual['configuration']==row['before']['configuration']
    assert json.loads(docker('exec',release.CONTAINERS['app'],'node','-e',release.TREE))==json.loads((release.RELEASE/'app-source-tree.json').read_text())
    assert {name:release.metadata(name) for name in release.DEPENDENCIES}==data['dependencies']
    live=json.loads(docker('exec','-i',release.CONTAINERS['app'],'node','--input-type=module',input=(SERVER/'tools/special-scm-lines-live.mjs').read_bytes()))
    result={'deployed':True,'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'appImage':row['candidateImageId'],
      'onlyAppChanged':True,'configurationPreserved':True,'migration':None,**live}
    save('result.json',result);print(json.dumps(result),flush=True)

def checks(data):
    for file in ['static.json','focused.json','tests.json','mutations.json','supplement.json','changed-lines.json']:
        evidence=json.loads((release.EVIDENCE/file).read_text())
        assert evidence['sourceHashes']==data['services']['app']['sourceHashes'],file+' source mismatch'
        assert not evidence.get('newFailures'),file+' regressions'
        assert evidence.get('counts',{}).get('fail',0)==0 or file=='tests.json'
        if file=='static.json':assert evidence['passed']
        if file=='mutations.json':assert evidence['total']==evidence['killed'] and evidence['total']>=3
        if file=='changed-lines.json':assert not evidence['uncovered']

def apply():
    data=state();release.current(data);checks(data);release.core.config_check(data)
    active=release.active_work();save('active-before.json',active);assert not any(active.values()),'Wait for active operations: '+json.dumps(active)
    try:
        with (release.RELEASE/'publish.log').open('wb') as log:
            subprocess.run(release.core.compose(data)+['up','-d','--no-build','--no-deps','--pull','never','app'],cwd=ROOT,stdout=log,stderr=subprocess.STDOUT,check=True,timeout=60)
        verify()
    except Exception:
        with (release.RELEASE/'rollback.log').open('wb') as log:
            subprocess.run(release.core.compose(data,'compose.rollback.yml')+['up','-d','--no-build','--no-deps','--pull','never','app'],cwd=ROOT,stdout=log,stderr=subprocess.STDOUT,check=True,timeout=60)
        release.core.core.ready(data['services']['app']['before']['imageId'])
        save('rollback-result.json',{'previousAppRestored':True});raise

if __name__=='__main__':{'capture':capture,'prepare':release.prepare,'apply':apply,'verify':verify}[sys.argv[1]]()
