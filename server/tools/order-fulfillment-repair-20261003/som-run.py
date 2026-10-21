import base64,json,os,subprocess,sys,time
from pathlib import Path
here=Path(__file__).resolve().parent
out=Path('/home/ubuntu/operatorapp-investigations/order-fulfillment-repair-20261003')
os.umask(0o077);mode=sys.argv[1];assert mode in ['snapshot','rehearse','apply','verify']
def module(name):return 'data:text/javascript;base64,'+base64.b64encode((here/name).read_bytes()).decode()
s=(here/'som-repair.mjs').read_text().replace("'/app/","'file:///app/").replace('./som-evidence.mjs',module('som-evidence.mjs'))
r=subprocess.run(['docker','exec','-i','-e','SOM_REPAIR_MODE='+mode,'mbbs-operator-app-app-1','node','--input-type=module'],input=s,text=True,capture_output=True,timeout=180)
(out/('som-'+mode+'.stderr')).write_text(r.stderr)
if r.returncode:
 print('\n'.join(l for l in r.stderr.splitlines() if len(l)<1500));raise SystemExit(r.returncode)
report=json.loads(r.stdout)
target=out/('som-'+mode+'.json')
if target.exists():target.rename(out/('som-'+mode+'-'+str(time.time_ns())+'.json'))
target.write_text(json.dumps(report,indent=2)+'\n')
print(json.dumps({k:report[k] for k in ['mode','result','verified','recordWrites','rollbackVerified'] if k in report},indent=2))
