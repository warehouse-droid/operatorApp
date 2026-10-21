import pathlib,subprocess,sys,json
root=pathlib.Path(__file__).resolve().parents[2];private=pathlib.Path('/home/ubuntu/operatorapp-investigations/netsuite-attention-20261003')
assert sys.argv[1] in ['dry-run','apply']
source='const APPLY='+json.dumps(sys.argv[1]=='apply')+';\n'+(root/'tools/netsuite-attention-20261003/remaining-if.mjs').read_text().replace("from '../../src/","from './src/")
result=subprocess.run(['docker','exec','-i','-w','/app','mbbs-operator-app-app-1','node','--input-type=module'],input=source,text=True,capture_output=True)
out=private/('remaining-'+sys.argv[1]+'.json');out.write_text(result.stdout);out.chmod(0o600)
if result.returncode:print(result.stderr[-2000:]);raise SystemExit(result.returncode)
data=json.loads(result.stdout);print(json.dumps({'apply':data['apply'],'remaining':data['proof']['remaining'],'status':data.get('result',{}).get('status')}))
