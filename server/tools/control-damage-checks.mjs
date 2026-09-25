import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdirSync,readFileSync,writeFileSync,readdirSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {mutants} from '../test/support/control-damage-mutation-loader.mjs';
const folder='test-artifacts/control-damage';mkdirSync(folder,{recursive:true});
const save=(name,value)=>writeFileSync(`${folder}/${name}.json`,JSON.stringify(value,null,2));
const production=['src/server.js','src/netsuite.js','src/inventory-damage-service.js','src/inventory-damage-repository.js','src/operator-inventory-router.js','public/control.js','public/control.html','public/app-sidebar.js','public/operator-inventory.js','public/operator.html','public/service-worker.js','public/i18n.js','src/control-damage-domain.js','src/control-damage-netsuite.js','src/control-damage-service.js','src/control-damage-review.js','src/control-damage-router.js','public/control-damage.js','public/control-damage.css','migrations/221_control_damage_adjustments.sql'];
const tests=readdirSync('test').filter(name=>/^control-damage-.*\.test\.js$/.test(name)).map(name=>'test/'+name);
if(process.argv[2]==='mutations') {
 const results=[];
 for(const [name,entry] of Object.entries(mutants)) {
  const result=spawnSync(process.execPath,['--loader','./test/support/control-damage-mutation-loader.mjs','--test',`test/control-damage-${entry[3]}.test.js`],{encoding:'utf8',timeout:60000,maxBuffer:4*1024*1024,env:{...process.env,CONTROL_DAMAGE_MUTANT:name}});
  const log=result.stdout+result.stderr;writeFileSync(`${folder}/mutation-${name}.log`,log);
  const killed=result.status===1 && log.includes(`CONTROL_DAMAGE_MUTATION_APPLIED:${name}`) && /# fail [1-9]/.test(log) && log.includes('AssertionError');
  results.push({name,killed});
 }
 save('mutations',results);console.log(JSON.stringify(results));assert.ok(results.every(row=>row.killed));
 const properties=[];
 for(const name of ['stale','removal']) {
  const result=spawnSync(process.execPath,['--loader','./test/support/control-damage-mutation-loader.mjs','--test','--test-name-pattern=CD6','test/control-damage-domain.test.js'],{encoding:'utf8',timeout:30000,env:{...process.env,CONTROL_DAMAGE_MUTANT:name}});
  const log=result.stdout+result.stderr;writeFileSync(`${folder}/property-mutation-${name}.log`,log);
  properties.push({name,killed:result.status===1 && log.includes('Property failed')});
 }
 save('property-mutations',properties);assert.ok(properties.every(row=>row.killed));
} else if(process.argv[2]==='source') {
 const files=[...production,...tests,'test/control-damage-spec.md','test/support/control-damage-schema.sql','test/support/control-damage-changed-lines.json','test/support/control-damage-mutation-loader.mjs',...readdirSync('tools').filter(name=>name.startsWith('control-damage-')).map(name=>'tools/'+name)];
 const sources=Object.fromEntries(files.map(file=>[file,createHash('sha256').update(readFileSync(file)).digest('hex')]));
 const versions=Object.fromEntries(['@playwright/test','c8','eslint','typescript','fast-check'].map(name=>[name,JSON.parse(readFileSync(`node_modules/${name}/package.json`)).version]));
 save('sources',{node:process.version,versions,sources});console.log(JSON.stringify({node:process.version,versions,files:files.length}));
} else if(process.argv[2]==='shuffle') {
 for(const file of [...tests].reverse()) {
  const run=spawnSync(process.execPath,['--test',file],{encoding:'utf8',timeout:90000,maxBuffer:4*1024*1024});
  writeFileSync(`${folder}/shuffle-${file.split('/').at(-1)}.log`,run.stdout+run.stderr);assert.equal(run.status,0,file+'\n'+run.stdout+run.stderr);
 }
 console.log(JSON.stringify({reorderedFiles:tests.length,passed:true}));
} else throw new Error('Expected mutations, source or shuffle');
