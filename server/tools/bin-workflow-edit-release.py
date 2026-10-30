#!/usr/bin/env python3
"""Release BIN edit-lock route planning over the captured live app."""
import runpy,json,sys,shutil,difflib
from pathlib import Path

base=runpy.run_path(str(Path(__file__).with_name('bin-selection-release.py')))
scope=base['prepare'].__globals__
scope.update(OUT=base['SERVER']/'deployments/bin-workflow-edit-locks-20261023',
  FILES=json.loads((base['SERVER']/'tools/bin-workflow-edit-files.json').read_text()),
  IMAGE='mbbs-operator-app:bin-workflow-edit-locks-20261023',ROLLBACK='mbbs-operator-app:bin-workflow-edit-locks-rollback-20261023')
def apply_migration():
    return {'required':False}
scope['apply_migration']=apply_migration

def prepare():
    out=scope['OUT'];out.mkdir(parents=True,exist_ok=True)
    state={k:base['metadata'](v) for k,v in base['SERVICES'].items()}
    if (out/'capture.json').exists():
        assert json.loads((out/'capture.json').read_text())==state,'Live changed; rebase before release'
    else:
        before=out/'live-before';before.mkdir(exist_ok=True)
        import subprocess,os
        for name in ['src','public','migrations','package.json','package-lock.json']:
            subprocess.run(['sudo','-n','docker','cp',base['APP']+':/app/'+name,str(before/name)],check=True)
        subprocess.run(['sudo','-n','chown','-R',f'{os.getuid()}:{os.getgid()}',str(before)],check=True)
        assert state=={k:base['metadata'](v) for k,v in base['SERVICES'].items()}
        base['save'](out/'capture.json',state)
    candidate=out/'candidate';shutil.copytree(out/'live-before',candidate,dirs_exist_ok=True)
    conflicts=[];patch=[]
    for file in scope['FILES']:
        live=(out/'live-before'/file).read_bytes() if (out/'live-before'/file).exists() else b''
        before=out/'workspace-before'/file
        content=base['merge'](live,before.read_bytes(),(base['SERVER']/file).read_bytes(),file,'workflow-edit') if before.exists() else (base['SERVER']/file).read_bytes()
        target=candidate/file;target.parent.mkdir(parents=True,exist_ok=True);target.write_bytes(content)
        if b'<<<<<<< ' in content: conflicts.append(file)
        patch.extend(difflib.unified_diff(live.decode().splitlines(True),content.decode().splitlines(True),fromfile='live/'+file,tofile='candidate/'+file))
    (out/'release.patch').write_text(''.join(patch))
    base['save'](out/'prepared.json',{'baseImage':state['app']['imageRef'],'conflicts':conflicts,
      'sourceHashes':{f:base['sha'](candidate/f) for f in scope['FILES']}})
    print(json.dumps({'baseImage':state['app']['imageRef'],'files':len(scope['FILES']),'conflicts':conflicts}))

if __name__=='__main__':
    {'prepare':prepare,**{name:base[name] for name in ['build','deploy','verify']}}[sys.argv[1]]()
