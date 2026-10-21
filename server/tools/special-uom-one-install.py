"""Install only verified fixed-one changes and preserve unrelated work."""
from pathlib import Path
import hashlib
import json
import re
import shutil
import sys

SOURCE=Path(__file__).resolve().parents[1]
TARGET=Path('/home/ubuntu/apps/operatorApp/server')
OUT=SOURCE/'test-artifacts/special-uom-one-20261003'
RELEASE=SOURCE/'deployments/special-uom-one-20261003'
digest=lambda value:hashlib.sha256(value).hexdigest()

def main():
    original=json.loads((OUT/'workspace-before-hashes.json').read_text())
    testOriginal=json.loads((OUT/'test-before-hashes.json').read_text())
    manifest=json.loads((RELEASE/'manifest.json').read_text())
    focused=json.loads((OUT/'focused.json').read_text());assert focused['counts']['fail']==0
    assert focused['sourceHashes']==manifest['services']['app']['sourceHashes']
    updates={}
    for file in original:
        target=TARGET/file;assert digest(target.read_bytes())==original[file],'Workspace changed: '+file
        content=(RELEASE/'candidate-app'/file).read_bytes();assert digest(content)==focused['sourceHashes'][file]
        if file=='public/scm-stock-requests.html':
            text,count=re.subn(r'(scm-special-stock-requests\.js\?[^"\n]+)(")',r'\1&uomOne=20261003-v1\2',target.read_text());assert count==1
            content=text.encode()
        updates[file]=content
    for file,expected in testOriginal.items():
        assert digest((TARGET/file).read_bytes())==expected,'Test changed: '+file
        updates[file]=(SOURCE/file).read_bytes()
    support=[*SOURCE.glob('tools/special-uom-one-*'),SOURCE/'test/special-uom-one-spec.md']
    for source in support:
        file=str(source.relative_to(SOURCE));assert not (TARGET/file).exists(),'New path exists: '+file;updates[file]=source.read_bytes()
    for folder in ['test-artifacts/special-uom-one-20261003','deployments/special-uom-one-20261003']:
        assert not (TARGET/folder).exists(),'Artifact folder exists: '+folder
    if sys.argv[-1]!='apply':print(json.dumps({'ready':True,'runtimeFiles':len(original),'revisedTests':len(testOriginal),'supportFiles':len(support)}));return
    for file,content in updates.items():
        path=TARGET/file;path.parent.mkdir(parents=True,exist_ok=True);path.write_bytes(content)
    for folder in ['test-artifacts/special-uom-one-20261003','deployments/special-uom-one-20261003']:shutil.copytree(SOURCE/folder,TARGET/folder)
    manifest['workspaceHashes']={file:digest((TARGET/file).read_bytes()) for file in original}
    (TARGET/'deployments/special-uom-one-20261003/manifest.json').write_text(json.dumps(manifest,indent=2)+'\n')
    assert all((TARGET/file).read_bytes()==content for file,content in updates.items())
    result={'installed':True,'runtimeFiles':len(original),'revisedTests':len(testOriginal),'unrelatedWorkspaceChangesPreserved':True,'sourceHashes':manifest['workspaceHashes']}
    (TARGET/'test-artifacts/special-uom-one-20261003/installed.json').write_text(json.dumps(result,indent=2)+'\n')
    print(json.dumps({key:value for key,value in result.items() if key!='sourceHashes'}))

if __name__=='__main__':main()
