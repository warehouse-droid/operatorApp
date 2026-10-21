import json,subprocess
from pathlib import Path
TASK=Path(__file__).resolve().parent
APP='mbbs-operator-app-app-1'
docker=['sudo','-n','docker']
def identity():return json.loads(subprocess.check_output(docker+['inspect','--format','{"imageId":"{{.Image}}","containerId":"{{.Id}}"}',APP]))
before=identity()
for file in json.loads((TASK/'files.json').read_text()):
 data=subprocess.check_output(docker+['exec',APP,'sh','-c','if [ -f "$1" ]; then cat "$1"; fi','sh','/app/'+file])
 if data:
  path=TASK/'release-baseline-v2'/file;path.parent.mkdir(parents=True,exist_ok=True);path.write_bytes(data)
assert identity()==before
(TASK/'capture-v2.json').write_text(json.dumps(before,indent=2)+'\n')
print(json.dumps(before))
