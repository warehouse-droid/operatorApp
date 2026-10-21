import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,readdirSync,symlinkSync,copyFileSync,existsSync,writeFileSync,rmSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
const out='test-artifacts/unified-stock-status',root=mkdtempSync('/tmp/unified-status-baseline-');
try{
  mkdirSync(root+'/public');mkdirSync(root+'/test/mbt/unit',{recursive:true});
  symlinkSync('/app/node_modules',root+'/node_modules');symlinkSync('/app/src',root+'/src');writeFileSync(root+'/package.json','{"type":"module"}');
  for(const file of readdirSync('public')){
    const baseline=`${out}/before/public/${file}`;
    if(existsSync(baseline))copyFileSync(baseline,`${root}/public/${file}`);
    else symlinkSync(`/app/public/${file}`,`${root}/public/${file}`);
  }
  const file='test/mbt/unit/stock-request-ui-contract.test.js';copyFileSync(file,`${root}/${file}`);
  const result=spawnSync(process.execPath,['--test',file],{cwd:root,encoding:'utf8',timeout:60000,env:{...process.env,NODE_V8_COVERAGE:''}});
  const log=(result.stdout||'')+(result.stderr||'');writeFileSync(`${out}/baseline-ui-contract.log`,log);
  const failures=[...log.matchAll(/^not ok \d+ - (.+)$/gm)].map(match=>match[1]).sort();
  assert.equal(result.status,1);assert.deepEqual(failures,[
    'Sales Request Stock has complete Simplified Chinese UI and validation coverage',
    'stock-request feedback is content-sized and availability shows Sales plus conversion equivalents'
  ].sort());
  writeFileSync(`${out}/baseline-ui-failures.json`,JSON.stringify(failures,null,2));
  console.log(JSON.stringify({verifiedPreExistingFailures:failures}));
}finally{rmSync(root,{recursive:true,force:true});}
