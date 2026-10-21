"""Bind changed JavaScript lines to the enhancement candidate bytes."""
import hashlib
import json
from pathlib import Path
import subprocess
import tempfile

ROOT=Path(__file__).resolve().parents[1]
OUT=ROOT/'test-artifacts/regular-waitlist-enhancements-20261002'
FILES=json.loads((ROOT/'tools/regular-waitlist-enhancements-files.json').read_text())
after=ROOT/'deployments/regular-waitlist-enhancements-20261002/candidate'
result={}
for file in FILES:
    if not file.endswith('.js'):
        continue
    before=OUT/'before'/file
    with tempfile.NamedTemporaryFile() as blank:
        diff=subprocess.run(['git','diff','--no-index','--unified=0','--',str(before if before.exists() else Path(blank.name)),str(after/file)],capture_output=True,text=True)
    assert diff.returncode in [0,1],diff.stderr
    result[file]={'sourceHash':hashlib.sha256((after/file).read_bytes()).hexdigest(),'diff':diff.stdout}
(OUT/'changed-diffs.json').write_text(json.dumps({'files':result},indent=2)+'\n')
print(json.dumps({'files':len(result)}))
