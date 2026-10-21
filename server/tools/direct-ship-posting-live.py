"""Execute task probes inside the app; keep credentials in its existing config."""
import json
from pathlib import Path
import subprocess
import sys

SERVER=Path(__file__).resolve().parents[1]
OUT=SERVER/'test-artifacts/direct-ship-posting-20261001'
APP='mbbs-operator-app-app-1'

def run(name,output,extra_env=None):
    args=['sudo','-n','docker','exec','-i']
    for key,value in (extra_env or {}).items():args.extend(['-e',key+'='+value])
    args.extend([APP,'node','--input-type=module'])
    script=(SERVER/'tools'/name).read_bytes()
    if b'/* AUDIT_SNAPSHOT */null' in script:
        snapshot=json.loads((OUT/'live-audit-before.json').read_text())
        script=script.replace(b'/* AUDIT_SNAPSHOT */null',json.dumps(snapshot).encode())
    result=subprocess.run(args,input=script,capture_output=True)
    (OUT/(output+'.stderr.log')).write_bytes(result.stderr)
    (OUT/(output+'.stdout.log')).write_bytes(result.stdout)
    if result.returncode:raise RuntimeError('Live script failed; inspect '+output+'.stderr.log')
    records=[]
    for line in result.stdout.decode().splitlines():
        try:records.append(json.loads(line))
        except json.JSONDecodeError:pass
    data=next(record for record in reversed(records) if 'summary' in record)
    (OUT/(output+'.json')).write_text(json.dumps(data,indent=2)+'\n')
    print(json.dumps(data.get('summary',data)))

if __name__=='__main__':
    mode=sys.argv[1]
    if mode=='audit':run('direct-ship-posting-audit.mjs','live-audit-before')
    elif mode=='retry':run('direct-ship-posting-retry.mjs','live-retry',{'DIRECT_SHIP_POSTING_APPLY':'1'})
    elif mode=='reconcile':run('direct-ship-posting-reconcile.mjs','live-reconciliation',{'DIRECT_SHIP_POSTING_APPLY':'1'})
    elif mode=='verify':run('direct-ship-posting-verify-live.mjs','live-verification')
    else:raise ValueError(mode)
