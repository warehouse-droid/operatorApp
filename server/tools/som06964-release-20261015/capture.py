import io,json,shutil,subprocess,tarfile
from pathlib import Path
TASK=Path(__file__).resolve().parent
SERVER=TASK.parents[1]
docker=['sudo','-n','docker']
app='mbbs-operator-app-app-1'
identity=lambda:json.loads(subprocess.check_output(docker+['inspect','--format','{"imageId":"{{.Image}}","containerId":"{{.Id}}"}',app]))
before=identity()
assert not (TASK/'baseline').exists()
(TASK/'baseline').mkdir()
data=subprocess.check_output(docker+['exec',app,'tar','-C','/app','-cf','-','src','public','migrations'])
with tarfile.open(fileobj=io.BytesIO(data)) as archive: archive.extractall(TASK/'baseline',filter='data')
assert identity()==before
shutil.copytree(TASK/'baseline',TASK/'candidate')
for name in json.loads((TASK/'files.json').read_text()):
    p=SERVER/name
    if p.exists():
        dest=TASK/'workspace-before'/name;dest.parent.mkdir(parents=True,exist_ok=True);shutil.copy2(p,dest)
(TASK/'capture.json').write_text(json.dumps(before,indent=2)+'\n')
print(json.dumps(before))
