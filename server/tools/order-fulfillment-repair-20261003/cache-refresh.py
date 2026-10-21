import base64,json,os,subprocess,sys,time
from pathlib import Path
here=Path(__file__).resolve().parent;out=Path('/home/ubuntu/operatorapp-investigations/operator-review-navigation-20261003');mode=sys.argv[1];assert mode in ['rehearse','apply'];os.umask(0o077)
s=(here/'cache-refresh.mjs').read_text().replace("'/app/","'file:///app/")
r=subprocess.run(['docker','exec','-i','-e','UOM_CACHE_MODE='+mode,'mbbs-operator-app-app-1','node','--input-type=module'],input=s,text=True,capture_output=True,timeout=180)
(out/('cache-'+mode+'.stderr')).write_text(r.stderr)
if r.returncode:print(r.stderr[-5000:]);raise SystemExit(r.returncode)
a=json.loads(r.stdout);target=out/('cache-'+mode+'.json')
if target.exists():target.rename(out/('cache-'+mode+'-'+str(time.time_ns())+'.json'))
target.write_text(json.dumps(a,indent=2));print(json.dumps({k:v for k,v in a['result'].items() if k!='patches'},indent=2))
