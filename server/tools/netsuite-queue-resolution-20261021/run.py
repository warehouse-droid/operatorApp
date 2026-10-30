"""Run reviewed operational reconciliation in the existing app; never post to NetSuite."""
import json
from pathlib import Path
import subprocess
import sys

HERE=Path(__file__).resolve().parent
OUT=HERE.parents[1]/'artifacts/netsuite-queue-resolution-20261021'
events=[json.loads(line) for line in (OUT/'remote-before.jsonl').read_text().splitlines()]
bundle={'inventory':json.loads((OUT/'inventory-before.json').read_text()),
        **{e['event']:e for e in events if e['event']!='existing-record'},
        'records':[e for e in events if e['event']=='existing-record']}
bundle['remaining']=json.loads((OUT/'remaining-before.json').read_text())
mode=sys.argv[1]
assert mode in ['review','rehearse','apply']
if '--splits-only' in sys.argv:
    assert mode=='rehearse'
    bundle['inventory']['native']=[]
    bundle['inventory']['sales']=[c for c in bundle['inventory']['sales'] if c['dispatchOrderRef'] in ['SOA08854-S1','SOA06143-S1']]
    bundle['local-evidence']['jobs']=[]
    bundle['headers']['headers']=[h for h in bundle['headers']['headers'] if h['tranid'] in ['SOA08854','SOA06143']]
    bundle['records']=[]
proof=(HERE/'proof.mjs').read_text().replace('../../src/','./src/').replace('export function ','function ')
code='const MODE='+json.dumps(mode)+';\nconst BUNDLE='+json.dumps(bundle)+';\n'+proof+'\n'+(HERE/'reconcile.mjs').read_text()
suffix=sys.argv[2] if len(sys.argv)>2 else ''
assert not suffix or (suffix.startswith('-') and suffix[1:].isalnum())
output=OUT/(mode+suffix+'.jsonl')
assert not output.exists(),'Retain the previous audit; use a fresh named run after review.'
with output.open('wb') as result:
    process=subprocess.run(['docker','exec','-i','-w','/app','mbbs-operator-app-app-1','node','--input-type=module'],
        input=code.encode(),stdout=result,stderr=subprocess.PIPE)
if process.stderr:sys.stderr.write(process.stderr.decode())
print(json.dumps({'mode':mode,'exit':process.returncode,'audit':str(output)}))
raise SystemExit(process.returncode)
