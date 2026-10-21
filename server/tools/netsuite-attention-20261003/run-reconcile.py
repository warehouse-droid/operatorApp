import pathlib,json,subprocess,sys
root=pathlib.Path(__file__).resolve().parents[2];private=pathlib.Path('/home/ubuntu/operatorapp-investigations/netsuite-attention-20261003')
apply=sys.argv[1]=='apply'
assert sys.argv[1] in ['dry-run','apply']
source=(root/'tools/netsuite-attention-20261003/reconcile.mjs').read_text()
helper=(root/'tools/netsuite-attention-20261003/verify-reviewed-existing.mjs').read_text().replace('export function','function')
source=source.replace("import {verifyReviewedExisting} from './verify-reviewed-existing.mjs';",helper)
source=source.replace("from '../../src/","from './src/")
source='const APPLY='+json.dumps(apply)+';const BUNDLE='+ (private/'review-bundle.json').read_text()+';const PLAN='+(private/'review-plan.json').read_text()+';\n'+source
result=subprocess.run(['docker','exec','-i','-w','/app','mbbs-operator-app-app-1','node','--input-type=module'],input=source,text=True,capture_output=True)
out=private/('reconcile-'+sys.argv[1]+'.json');out.write_text(result.stdout);out.chmod(0o600)
if result.stderr:
 (private/('reconcile-'+sys.argv[1]+'.error.log')).write_text(result.stderr)
 print(result.stderr[-1600:])
if result.returncode:raise SystemExit(result.returncode)
data=json.loads(result.stdout);print(json.dumps({'apply':apply,'cases':len(data['results']),'errors':[r for r in data['results'] if r.get('error')]}))
