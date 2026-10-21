"""Reproduce the two unrelated current failures with this task's changes removed.

Runs only in the isolated test runner. Source and original runtime snapshots stay
untouched; the temporary copy is deleted afterward.
"""
import json,pathlib,subprocess
root=pathlib.Path(__file__).resolve().parents[2]
baseline=pathlib.Path('/home/ubuntu/operatorapp-investigations/netsuite-attention-20261003/runtime-before')
files=json.loads((root/'tools/netsuite-attention-20261003/deployment-files.json').read_text())
originals={file:(baseline/file).read_text() if (baseline/file).exists() else None for file in files}
source='const originals='+json.dumps(originals)+''';
import {cpSync,mkdtempSync,mkdirSync,writeFileSync,rmSync,symlinkSync} from 'node:fs';
import {dirname,join} from 'node:path';
import {spawnSync} from 'node:child_process';
const target=mkdtempSync('/tmp/attention-baseline-');
try {
 for(const file of ['src','public','test/support','package.json']) {
  mkdirSync(dirname(join(target,file)),{recursive:true});cpSync(join('/app',file),join(target,file),{recursive:true});
 }
 symlinkSync('/app/node_modules',join(target,'node_modules'));
 const tests=['test/mbt/unit/special-stock-request-wiring.red.test.js','test/mbt/integration/special-case-fields-http.test.js'];
 for(const file of tests){mkdirSync(dirname(join(target,file)),{recursive:true});cpSync(join('/app',file),join(target,file));}
 for(const [file,content] of Object.entries(originals)) {
  if(content===null)rmSync(join(target,file),{force:true});else writeFileSync(join(target,file),content);
 }
 const result=spawnSync(process.execPath,['--test',...tests],{cwd:target,env:process.env,stdio:'inherit'});
 process.exitCode=result.status??1;
}finally{rmSync(target,{recursive:true,force:true});}
'''
out=root/'test-artifacts/netsuite-attention-20261003/unrelated-current-baseline.log'
with out.open('w') as log:
 result=subprocess.run(['docker','exec','-i','-w','/app','mbbs-to-reference-20261003-runner','node','--input-type=module'],input=source,text=True,stdout=log,stderr=subprocess.STDOUT)
print(json.dumps({'exit':result.returncode,'log':str(out),'expected':'Both unrelated baseline failures persist'}))
