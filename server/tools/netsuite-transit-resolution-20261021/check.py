import json
from pathlib import Path
import subprocess
import sys

HERE=Path(__file__).resolve().parent
OUT=HERE.parents[1]/'artifacts/netsuite-transit-resolution-20261021'
mode=sys.argv[1]
assert mode in ['before','inspect','verify']
before=json.loads((OUT/'read-before.jsonl').read_text().splitlines()[0])
code='const MODE='+json.dumps(mode)+';\nconst BEFORE='+json.dumps(before)+';\n'+(HERE/'check.mjs').read_text()
suffix=sys.argv[2] if len(sys.argv)>2 else ''
assert not suffix or (suffix.startswith('-') and suffix[1:].isalnum())
with (OUT/(mode+suffix+'.json')).open('xb') as f:
    p=subprocess.run(['docker','exec','-i','-w','/app','mbbs-operator-app-app-1','node','--input-type=module'],input=code.encode(),stdout=f,stderr=subprocess.PIPE)
if p.stderr:sys.stderr.write(p.stderr.decode())
print(json.dumps({'mode':mode,'exit':p.returncode}))
raise SystemExit(p.returncode)
