"""Rehearse/apply the reviewed supplementary local reconciliation, without NS posts."""
import json,pathlib,subprocess,sys
root=pathlib.Path(__file__).resolve().parents[2]
private=pathlib.Path('/home/ubuntu/operatorapp-investigations/netsuite-attention-20261003')
mode=sys.argv[1];assert mode in ('dry-run','apply')
source=(root/'tools/netsuite-attention-20261003/supplement-reconcile.mjs').read_text().replace("from '../../src/","from './src/")
source='const APPLY='+json.dumps(mode=='apply')+'; const REVIEW='+(private/'supplement-read.json').read_text()+';\n'+source
result=subprocess.run(['docker','exec','-i','-w','/app','mbbs-operator-app-app-1','node','--input-type=module'],input=source,text=True,capture_output=True)
out=private/f'supplement-{mode}.json';out.write_text(result.stdout);out.chmod(0o600)
if result.stderr:
 error=private/f'supplement-{mode}.error.log';error.write_text(result.stderr);error.chmod(0o600)
if result.returncode:print(result.stderr[-1800:]);raise SystemExit(result.returncode)
print(result.stdout)
