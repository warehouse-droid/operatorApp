import assert from 'node:assert/strict';
import {cpSync,mkdtempSync,readFileSync,writeFileSync,symlinkSync,rmSync} from 'node:fs';
import {resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
assert.equal(process.env.MBT_TEST_ISOLATED,'1');
const out='test-artifacts/special-workflow-review/request-enhancements-20260928';
const root=mkdtempSync('/tmp/special-enhancement-baseline-');
try{
 for(const folder of ['src','public','test','migrations'])cpSync(folder,root+'/'+folder,{recursive:true});
 cpSync('package.json',root+'/package.json');symlinkSync(resolve('node_modules'),root+'/node_modules','dir');
 const baseline=JSON.parse(readFileSync(out+'/baseline-manifest.json'));
 for(const file of Object.keys(baseline))cpSync(out+'/baseline/'+file,root+'/'+file);
 const result=spawnSync(process.execPath,['--test','--test-name-pattern=closure and planning serialize','test/mbt/integration/special-workflow-pricing-http.test.js'],{cwd:root,encoding:'utf8',timeout:60000});
 const log=(result.stdout||'')+(result.stderr||'');writeFileSync(out+'/preexisting-closure-failure.log',log);
 assert.equal(result.status,1);assert.match(log,/SPECIAL_PO_APPROVAL_REQUIRED/);assert.match(log,/SPECIAL_CLOSURE_PENDING/);assert.match(log,/# fail 1/);
 console.log('Verified on captured baseline: existing closure/planning test reaches the PO approval guard before its expected closure guard.');
}finally{rmSync(root,{recursive:true,force:true});}
