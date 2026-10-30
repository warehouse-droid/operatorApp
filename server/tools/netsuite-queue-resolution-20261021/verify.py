import json
from pathlib import Path
import subprocess

here=Path(__file__).resolve().parent
out=here.parents[1]/'artifacts/netsuite-queue-resolution-20261021'
events=[json.loads(line) for line in (out/'apply.jsonl').read_text().splitlines()]
plan=next(e for e in events if e['event']=='plan')
inventory=json.loads((out/'inventory-before.json').read_text())
code='const PLAN='+json.dumps(plan)+';\nconst INVENTORY='+json.dumps(inventory)+';\n'+(here/'verify.mjs').read_text()
with (out/'verification-after.json').open('wb') as output:
    subprocess.run(['docker','exec','-i','-w','/app','mbbs-operator-app-app-1','node','--input-type=module'],input=code.encode(),stdout=output,check=True)
print((out/'verification-after.json').read_text())
