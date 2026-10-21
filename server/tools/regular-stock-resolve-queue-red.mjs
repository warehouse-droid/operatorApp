import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {cpSync,readFileSync,writeFileSync,mkdtempSync,symlinkSync,rmSync} from 'node:fs';
import {resolve} from 'node:path';

assert.equal(process.env.MBT_TEST_ISOLATED,'1');
assert.equal(new URL(process.env.DATABASE_URL).hostname,'mbbs-special-review-db');
const out=resolve('test-artifacts/regular-stock-resolve-20261002'),root=mkdtempSync('/tmp/resolve-queue-red-');
const file='public/scm-stock-requests.js',source=readFileSync(file,'utf8');
const needle='if (action === "queue") {\n      scmStockState.resolveDraft=null;';
assert.equal(source.split(needle).length,2);
try{
  for(const folder of ['src','public','migrations','test','tools'])cpSync(folder,root+'/'+folder,{recursive:true});
  for(const name of ['package.json','netsuite-smart-scm-picking-ticket-restlet.js'])cpSync(name,root+'/'+name);
  symlinkSync(resolve('node_modules'),root+'/node_modules','dir');
  writeFileSync(root+'/'+file,source.replace(needle,'if (action === "queue") {'));
  const result=spawnSync(process.execPath,['--test','--test-name-pattern=^changing queues','test/mbt/integration/regular-stock-resolution-browser.test.js'],
    {cwd:root,encoding:'utf8',timeout:60000,maxBuffer:20000000});
  const log=(result.stdout||'')+(result.stderr||'');writeFileSync(out+'/queue-draft-mutant.log',log);
  assert.equal(result.status,1,log);assert.match(log,/not ok \d+ - changing queues discards an unfinished Resolve reply/);
  console.log(JSON.stringify({queueDraftMutantKilled:true,test:'changing queues discards an unfinished Resolve reply without submitting or closing the case'}));
}finally{rmSync(root,{recursive:true,force:true});}
