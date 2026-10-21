"""Read-only release checks; never simulates physical completion or calls a transform."""
import hashlib,json,pathlib,subprocess
root=pathlib.Path(__file__).resolve().parents[2];evidence=root/'test-artifacts/to-line-reference-20261003'
manifest=json.loads((evidence/'deployment-manifest.json').read_text())
def run(*args):return subprocess.check_output(args,text=True).strip()
def http(url):
 data=subprocess.check_output(['curl','-fsS','--max-time','10','--write-out','\n%{http_code}',url]);body,_,status=data.rpartition(b'\n')
 assert status==b'200',f'Unexpected HTTP status: {status.decode()}'
 return body
container=json.loads(run('docker','inspect','mbbs-operator-app-app-1'))[0]
expected=run('docker','image','inspect','--format','{{.Id}}',manifest['candidateImage'])
assert container['Image']==expected,'Another deployment replaced the candidate'
script="import fs from 'node:fs';import crypto from 'node:crypto';const files="+json.dumps(list(manifest['files']))+";console.log(JSON.stringify(Object.fromEntries(files.map(f=>[f,crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex')]))));"
actual=json.loads(run('docker','exec','-w','/app','mbbs-operator-app-app-1','node','--input-type=module','-e',script))
assert actual==manifest['files'],'Live source differs from the tested overlay'
local_health={'status':200,'body':json.loads(http('http://127.0.0.1:3000/health'))}
public_health={'status':200,'body':json.loads(http('https://test.mbbsoperation.com/health'))}
assets={}
for name in ['operator.js','service-worker.js','mbt-gates.js']:
 assets[name]=hashlib.sha256(http('https://test.mbbsoperation.com/'+name)).hexdigest()
 assert assets[name]==manifest['files']['public/'+name],f'Public asset mismatch: {name}'
subprocess.run(['python3',str(root/'tools/to-line-reference-20261003/audit.py'),'live-cached-after.json','audit-cached.mjs'],check=True)
before=json.loads((evidence/'live-cached-before.json').read_text());after=json.loads((evidence/'live-cached-after.json').read_text())
assert before['quantityHash']==after['quantityHash'],'Quantities changed concurrently; review before claiming preservation'
worker=json.loads(run('docker','inspect','mbbs-operator-app-webhook-worker-1'))[0]
result={'appImage':container['Image'],'sourceFilesVerified':len(actual),'containerHealth':container['State']['Health']['Status'],
 'localHealth':local_health,'publicHealth':public_health,'publicAssetHashes':assets,'quantitiesUnchanged':True,
 'tob01189':after['tob01189'],'state':after['state'],'webhookWorkerImage':worker['Image']}
(evidence/'live-verification.json').write_text(json.dumps(result,indent=2)+'\n')
print(json.dumps({k:v for k,v in result.items() if k not in ['tob01189','publicAssetHashes']}))
