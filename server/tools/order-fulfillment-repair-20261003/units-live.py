import base64,json,os,subprocess
from pathlib import Path
here=Path(__file__).resolve().parent;out=Path('/home/ubuntu/operatorapp-investigations/operator-review-navigation-20261003');os.umask(0o077)
def uri(source):return 'data:text/javascript;base64,'+base64.b64encode(source.encode()).decode()
unit=uri((out/'candidate/src/netsuite-transaction-units.js').read_text())
source=(out/'candidate/src/netsuite.js').read_text().replace('./netsuite-transaction-units.js',unit).replace("'./","'file:///app/src/").replace('"./','"file:///app/src/')
runner=(here/'units-live.mjs').read_text().replace('./candidate-netsuite.js',uri(source)).replace("'/app/","'file:///app/")
runner='try { await import('+json.dumps(uri(runner))+'); } catch(e) { console.error(JSON.stringify({name:e.name,code:e.code,message:e.message,actual:e.actual,expected:e.expected,query:globalThis.unitQuery})); process.exitCode=1; }'
r=subprocess.run(['docker','exec','-i','mbbs-operator-app-app-1','node','--input-type=module'],input=runner,text=True,capture_output=True,timeout=180)
(out/'units-live.stderr').write_text(r.stderr)
if r.returncode:
 print('\n'.join(l for l in r.stderr.splitlines() if len(l)<1500)[-7000:]);raise SystemExit(r.returncode)
report=json.loads(r.stdout);(out/'units-live.json').write_text(json.dumps(report,indent=2));print(json.dumps({k:report[k] for k in ['verified','order','salesQuantity','salesUom','readers','otherConvertedItems']},indent=2))
