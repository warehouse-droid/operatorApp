import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdirSync,writeFileSync} from 'node:fs';
import {mutants} from '../test/support/operator-inventory-mutation-loader.mjs';
const directory='test-artifacts/operator-inventory/mutations';mkdirSync(directory,{recursive:true});
const results=[];
for(const [name,mutant] of Object.entries(mutants)) {
  for(const propertyOnly of name==='conversion'?[false,true]:[false]) {
    const args=['--loader','./test/support/operator-inventory-mutation-loader.mjs','--test'];
    if(propertyOnly) {args.push('--test-name-pattern=properties');}
    args.push(`test/operator-inventory-${mutant[3]}.test.js`);
    const run=spawnSync(process.execPath,args,{encoding:'utf8',timeout:60000,env:{...process.env,INVENTORY_MUTANT:name}});
    const log=run.stdout+run.stderr;
    const killed=run.status===1 && log.includes(`INVENTORY_MUTATION_APPLIED:${name}`) && /# fail [1-9]/.test(log) && log.includes(propertyOnly?'Counterexample:':'AssertionError');
    results.push({name,propertyOnly,killed});writeFileSync(`${directory}/${name}${propertyOnly?'-property':''}.log`,log);
  }
}
writeFileSync(`${directory}/results.json`,JSON.stringify(results,null,2));console.log(JSON.stringify(results));
assert.ok(results.every(result=>result.killed),'A mutation survived or was invalid');
