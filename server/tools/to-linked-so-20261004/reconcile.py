"""Stage reviewed modules in memory, verify NetSuite, then rehearse/apply local repair."""
import base64,json,pathlib,subprocess,sys
root=pathlib.Path(__file__).resolve().parents[2]
private=pathlib.Path('/home/ubuntu/operatorapp-investigations/to-linked-so-20261004')
mode=sys.argv[1];assert mode in ('dry-run','apply')
urls={}
for file in ['transfer-order-posting-link-domain.js','transfer-order-posting-domain.js','transfer-order-posting-repository.js']:
 source=(root/'src'/file).read_text()
 for name,url in urls.items():source=source.replace("from './"+name+"'","from '"+url+"'")
 source=source.replace("from './","from 'file:///app/src/")
 urls[file]='data:text/javascript;base64,'+base64.b64encode(source.encode()).decode()
imports='import {linkedTransferDriverScope,transferPostingDate} from '+json.dumps(urls['transfer-order-posting-link-domain.js'])+';\n'
imports+='import {transferPostingCompletion} from '+json.dumps(urls['transfer-order-posting-domain.js'])+';\n'
imports+='import {readTransferCompletionEvents} from '+json.dumps(urls['transfer-order-posting-repository.js'])+';\n'
source='const APPLY='+json.dumps(mode=='apply')+';\n'+imports+(root/'tools/to-linked-so-20261004/reconcile.mjs').read_text().replace("from '../../src/","from './src/")
result=subprocess.run(['docker','exec','-i','-w','/app','mbbs-operator-app-app-1','node','--input-type=module'],input=source,text=True,capture_output=True)
out=private/f'reconcile-{mode}.json';out.write_text(result.stdout);out.chmod(0o600)
if result.stderr:
 error=private/f'reconcile-{mode}.error.log';error.write_text(result.stderr);error.chmod(0o600)
if result.returncode:
 # data-module stack locations can be very large; keep them in the private log.
 print('\n'.join(line for line in result.stderr.splitlines() if 'data:text/' not in line)[-2500:]);raise SystemExit(result.returncode)
print(result.stdout)
