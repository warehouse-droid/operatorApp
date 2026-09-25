import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import assert from 'node:assert/strict';
for(const args of [
 ['tools/load-followup-checks.mjs','suite'],
 ['tools/load-followup-checks.mjs','static'],
 ['tools/load-followup-checks.mjs','coverage'],
 ['tools/load-followup-mutations.mjs'],
 ['tools/load-followup-checks.mjs','shuffle'],
 ['--test','--test-concurrency=1','test/mbt/integration/local-load-performance.test.js','test/mbt/integration/operator-background-photos.test.js']
]){
 const name=args.at(-1).split('/').at(-1).replace('.mjs','').replace('.test.js','');
 const result=spawnSync(process.execPath,args,{encoding:'utf8',timeout:300000,maxBuffer:64*1024*1024});
 const output=(result.stdout||'')+(result.stderr||'');
 fs.writeFileSync(`test-artifacts/load-followup/final-${name}.log`,output);
 console.log(JSON.stringify({args,status:result.status}));
 assert.equal(result.status,0,output.slice(-10000));
}
