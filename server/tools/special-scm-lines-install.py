"""Install only verified SCM line and required-date changes, preserving unrelated work."""
from pathlib import Path
import hashlib
import json
import subprocess
import shutil
import sys

SOURCE=Path(__file__).resolve().parents[1]
TARGET=Path('/home/ubuntu/apps/operatorApp/server')
OUT=SOURCE/'test-artifacts/special-scm-lines-20261003'
RELEASE=SOURCE/'deployments/special-scm-lines-20261003'
digest=lambda value:hashlib.sha256(value).hexdigest()

def main():
    original=json.loads((OUT/'workspace-before-hashes.json').read_text())
    testOriginal=json.loads((OUT/'test-before-hashes.json').read_text())
    manifest=json.loads((RELEASE/'manifest.json').read_text())
    focused=json.loads((OUT/'focused.json').read_text());assert focused['counts']['fail']==0
    assert focused['sourceHashes']==manifest['services']['app']['sourceHashes']
    updates={}
    for file in original:
        target=TARGET/file
        assert (digest(target.read_bytes()) if target.exists() else None)==original[file],'Workspace changed: '+file
        content=(RELEASE/'candidate-app'/file).read_bytes();assert digest(content)==focused['sourceHashes'][file]
        old=RELEASE/'before-app'/file
        if old.exists():
            merged=subprocess.run(['git','merge-file','-p',str(RELEASE/'candidate-app'/file),str(old),str(target)],text=True,capture_output=True)
            assert merged.returncode==0,'Workspace merge conflict: '+file
            content=merged.stdout.encode()
        updates[file]=content
    for file,expected in testOriginal.items():
        assert digest((TARGET/file).read_bytes())==expected,'Test changed: '+file
        updates[file]=(SOURCE/file).read_bytes()
    support=[*SOURCE.glob('tools/special-scm-lines-*'),SOURCE/'test/special-scm-lines-spec.md',SOURCE/'test/special-scm-lines-evidence.md']
    for source in support:
        file=str(source.relative_to(SOURCE));assert not (TARGET/file).exists(),'New path exists: '+file;updates[file]=source.read_bytes()
    for folder in ['test-artifacts/special-scm-lines-20261003','deployments/special-scm-lines-20261003']:
        assert not (TARGET/folder).exists(),'Artifact folder exists: '+folder
    if sys.argv[-1]!='apply':print(json.dumps({'ready':True,'runtimeFiles':len(original),'revisedTests':len(testOriginal),'supportFiles':len(support)}));return
    for file,content in updates.items():
        path=TARGET/file;path.parent.mkdir(parents=True,exist_ok=True);path.write_bytes(content)
    for folder in ['test-artifacts/special-scm-lines-20261003','deployments/special-scm-lines-20261003']:shutil.copytree(SOURCE/folder,TARGET/folder)
    manifest['workspaceHashes']={file:digest((TARGET/file).read_bytes()) for file in original}
    (TARGET/'deployments/special-scm-lines-20261003/manifest.json').write_text(json.dumps(manifest,indent=2)+'\n')
    assert all((TARGET/file).read_bytes()==content for file,content in updates.items())
    result={'installed':True,'runtimeFiles':len(original),'revisedTests':len(testOriginal),'unrelatedWorkspaceChangesPreserved':True,'sourceHashes':manifest['workspaceHashes']}
    (TARGET/'test-artifacts/special-scm-lines-20261003/installed.json').write_text(json.dumps(result,indent=2)+'\n')
    print(json.dumps({key:value for key,value in result.items() if key!='sourceHashes'}))

if __name__=='__main__':main()
