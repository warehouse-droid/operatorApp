"""Invoke the deployed reconciliation service; preserve every operational audit."""
import json
from pathlib import Path
import subprocess
import sys

HERE=Path(__file__).resolve().parent
OUT=HERE.parents[1]/'artifacts/netsuite-transit-resolution-20261021'
mode=sys.argv[1]
assert mode in ['propose','apply']
events=[json.loads(line) for line in (OUT/'read-before.jsonl').read_text().splitlines()]
local=next(e for e in events if e['event']=='local')
orders=next(e['orders'] for e in events if e['event']=='orders')
targets={kind:[o['tranid'] for o in orders if o['kind']==kind] for kind in ['TO','PO']}
proposals=[]
if mode=='apply':
    proposals=[json.loads(line) for line in (OUT/'propose.jsonl').read_text().splitlines()]
    proposals=[e for e in proposals if e['event']=='proposal']
    assert len(proposals)==2
code='const MODE='+json.dumps(mode)+';\nconst TARGETS='+json.dumps(targets)+';\nconst PROPOSALS='+json.dumps(proposals)+';\n'+(HERE/'run.mjs').read_text()
output=OUT/(mode+'.jsonl')
with output.open('xb') as result:
    process=subprocess.run(['docker','exec','-i','-w','/app','mbbs-operator-app-app-1','node','--input-type=module'],input=code.encode(),stdout=result,stderr=subprocess.PIPE)
if process.stderr:sys.stderr.write(process.stderr.decode())
print(json.dumps({'mode':mode,'exit':process.returncode,'audit':str(output)}))
raise SystemExit(process.returncode)
