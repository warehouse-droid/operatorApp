import json
from pathlib import Path
import subprocess
import sys
HERE=Path(__file__).resolve().parent
OUT=HERE.parents[1]/'artifacts/netsuite-transit-resolution-20261021'
mode=sys.argv[1]
assert mode in ['rehearse','apply']
events=[json.loads(s) for s in (OUT/'read-before.jsonl').read_text().splitlines()]
values={'MODE':mode,'BEFORE':events[0],'BASELINE':json.loads((OUT/'before.json').read_text()),
        'ORDERS':next(e['orders'] for e in events if e['event']=='orders'),
        'RECEIPTS':[json.loads(s) for s in (OUT/'receipts.jsonl').read_text().splitlines()]}
code=''.join('const '+k+'='+json.dumps(v)+';\n' for k,v in values.items())+(HERE/'finish.mjs').read_text()
suffix=sys.argv[2] if len(sys.argv)>2 else ''
assert not suffix or (suffix.startswith('-') and suffix[1:].isalnum())
with (OUT/('finish-'+mode+suffix+'.jsonl')).open('xb') as f:
    p=subprocess.run(['docker','exec','-i','-w','/app','mbbs-operator-app-app-1','node','--input-type=module'],input=code.encode(),stdout=f,stderr=subprocess.PIPE)
if p.stderr:sys.stderr.write(p.stderr.decode())
print(json.dumps({'mode':mode,'exit':p.returncode}))
raise SystemExit(p.returncode)
