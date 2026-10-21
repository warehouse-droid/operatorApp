"""Persist this verified task while preserving unrelated workspace edits."""
from pathlib import Path
import hashlib
import json
import re
import shutil
import sys

SOURCE=Path(__file__).resolve().parents[1]
TARGET=Path('/home/ubuntu/apps/operatorApp/server')
OUT=SOURCE/'test-artifacts/special-case-fields-20261003'
RELEASE=SOURCE/'deployments/special-case-fields-20261003'
digest=lambda value:hashlib.sha256(value).hexdigest()

def main():
    original=json.loads((OUT/'workspace-before-hashes.json').read_text())
    files=json.loads((SOURCE/'tools/special-case-fields-files.json').read_text())
    release=json.loads((RELEASE/'manifest.json').read_text())
    focused=json.loads((OUT/'focused.json').read_text())
    assert focused['counts']['fail']==0
    assert focused['sourceHashes']==release['services']['app']['sourceHashes']
    updates={}
    for file in files:
        target=TARGET/file
        if file in original:assert digest(target.read_bytes())==original[file],'Workspace changed: '+file
        else:assert not target.exists(),'New path already exists: '+file
        content=(RELEASE/'candidate-app'/file).read_bytes()
        assert digest(content)==focused['sourceHashes'][file]
        if file=='public/scm-stock-requests.html':
            text,count=re.subn(r'(scm-special-stock-requests\.js\?[^"\n]+)(")',r'\1&lineFields=20261003-v1\2',target.read_text())
            assert count==1
            content=text.encode()
        updates[file]=content
    support=[*SOURCE.glob('tools/special-case-fields-*'),SOURCE/'test/special-case-fields-spec.md',
      *SOURCE.glob('test/special-case-fields-evidence.md'),
      *SOURCE.glob('test/mbt/unit/special-case-fields*.test.js'),*SOURCE.glob('test/mbt/integration/special-case-fields*.test.js')]
    for source in support:
        relative=str(source.relative_to(SOURCE));target=TARGET/relative
        assert not target.exists(),'Supporting path already exists: '+relative
        updates[relative]=source.read_bytes()
    for folder in ['test-artifacts/special-case-fields-20261003','deployments/special-case-fields-20261003']:
        assert not (TARGET/folder).exists(),'Artifact folder already exists: '+folder
    if sys.argv[-1]!='apply':
        print(json.dumps({'ready':True,'runtimeFiles':len(files),'supportFiles':len(support),'unrelatedWorkspaceChangesPreserved':True}));return
    for file,content in updates.items():
        target=TARGET/file;target.parent.mkdir(parents=True,exist_ok=True);target.write_bytes(content)
    for folder in ['test-artifacts/special-case-fields-20261003','deployments/special-case-fields-20261003']:
        shutil.copytree(SOURCE/folder,TARGET/folder)
    installed={file:digest((TARGET/file).read_bytes()) for file in files}
    release['workspaceHashes']=installed
    (TARGET/'deployments/special-case-fields-20261003/manifest.json').write_text(json.dumps(release,indent=2)+'\n')
    result={'installed':True,'runtimeFiles':len(files),'supportFiles':len(support),'sourceHashes':installed,'unrelatedWorkspaceChangesPreserved':True}
    (TARGET/'test-artifacts/special-case-fields-20261003/installed.json').write_text(json.dumps(result,indent=2)+'\n')
    assert all((TARGET/file).read_bytes()==content for file,content in updates.items())
    print(json.dumps({'installed':True,'runtimeFiles':len(files),'supportFiles':len(support),'unrelatedWorkspaceChangesPreserved':True}))

if __name__=='__main__':main()
