import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
const cases={hash:'test/mbt/unit/load-followup.test.js',missing:'test/mbt/unit/load-followup.test.js',claims:'test/mbt/integration/load-followup.test.js',observed:'test/mbt/unit/load-followup-posting.test.js',completed:'test/mbt/unit/load-followup.test.js',repair_rollback:'test/mbt/integration/load-followup-repair.test.js',repair_item:'test/mbt/integration/load-followup-repair.test.js'};
const results=[];
for(const [name,file] of Object.entries(cases)){
 const modes=['hash','missing'].includes(name)?['suite','property']:['suite'];
 for(const mode of modes){
  const result=spawnSync(process.execPath,['--loader','./test/support/load-followup-mutation-loader.mjs','--test',...(mode==='property'?['--test-name-pattern=property:']:[]),file],{env:{...process.env,LOAD_FOLLOWUP_MUTANT:name},encoding:'utf8',timeout:90000,maxBuffer:8*1024*1024});
  const output=(result.stdout||'')+(result.stderr||'');fs.writeFileSync(`test-artifacts/load-followup/mutation-${name}-${mode}.log`,output);
  const killed=result.status!==0&&/failureType: 'testCodeFailure'/.test(output)&&(/ERR_ASSERTION/.test(output)||/Property failed after/.test(output));
  results.push({name,mode,killed,status:result.status});console.log(JSON.stringify(results.at(-1)));assert.ok(killed,`${name} ${mode} survived or failed outside an assertion`);
 }
}
const sources=[...JSON.parse(fs.readFileSync('test-artifacts/load-followup/files.json')).filter(file=>file.startsWith('src/')),'src/operator-load-state.js','src/operator-load-state-repository.js','public/operator.js','tools/sob120541-repair.mjs'];
fs.writeFileSync('test-artifacts/load-followup/mutations.json',JSON.stringify({results,sourceHashes:Object.fromEntries(sources.map(file=>[file,crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')]))},null,2));
