import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {mutants} from '../test/support/damage-description-fix-mutation-loader.mjs';
const folder='test-artifacts/damage-description-fix';
mkdirSync(folder,{recursive:true});
if(process.argv[2]==='mutations') {
  const results=[];
  for(const name of Object.keys(mutants)) {
    const run=spawnSync(process.execPath,['--loader','./test/support/damage-description-fix-mutation-loader.mjs','--test','test/operator-inventory-damage.test.js'],{encoding:'utf8',timeout:60000,env:{...process.env,DAMAGE_DESCRIPTION_MUTANT:name}});
    const log=run.stdout+run.stderr;
    const killed=run.status===1 && log.includes(`DAMAGE_DESCRIPTION_MUTATION_APPLIED:${name}`) && /# fail [1-9]/.test(log) && log.includes('AssertionError');
    writeFileSync(`${folder}/mutation-${name}.log`,log);results.push({name,killed});
  }
  writeFileSync(`${folder}/mutations.json`,JSON.stringify(results,null,2));console.log(JSON.stringify(results));
  assert.ok(results.every(row=>row.killed));
} else if(process.argv[2]==='coverage') {
  const file='src/inventory-damage-service.js';
  const coverage=JSON.parse(readFileSync(`${folder}/coverage/coverage-final.json`,'utf8'))[`/app/${file}`];
  // These are the executable statements changed by this correction.
  const anchors=['function marker(report)','const description=String(line.description','return description===marker(report)','custcol_atlas_rc_so:{id:String(report.reason_id)},description:marker(report)',".filter(line=>matchesReport(line,report))",'const local=reports.find(report=>matchesReport(line,report))'];
  const source=readFileSync(file,'utf8').split('\n');
  const changed=anchors.map(anchor=>{const line=source.findIndex(text=>text.includes(anchor))+1;assert.ok(line>0,anchor);return line;});
  const missed=changed.filter(line=>!Object.entries(coverage.statementMap).some(([key,statement])=>statement.start.line<=line && statement.end.line>=line && coverage.s[key]>0));
  assert.deepEqual(missed,[]);
  const result={changedExecutableLines:changed,covered:changed.length,missed};
  writeFileSync(`${folder}/changed-coverage.json`,JSON.stringify(result,null,2));console.log(JSON.stringify(result));
} else if(process.argv[2]==='source') {
  const files=['src/inventory-damage-service.js','test/operator-inventory-damage.test.js','test/damage-description-fix-spec.md','test/support/damage-description-fix-mutation-loader.mjs','tools/damage-description-fix-checks.mjs','tools/damage-description-fix-checks.sh','tools/damage-description-fix-deploy.py','tools/damage-description-fix-recover.mjs'];
  const sources=Object.fromEntries(files.map(file=>[file,createHash('sha256').update(readFileSync(file)).digest('hex')]));
  const versions=Object.fromEntries(['c8','eslint','typescript','fast-check'].map(name=>[name,JSON.parse(readFileSync(`node_modules/${name}/package.json`)).version]));
  writeFileSync(`${folder}/sources.json`,JSON.stringify({node:process.version,versions,sources},null,2));console.log(JSON.stringify({node:process.version,versions,files:files.length}));
} else throw new Error('Expected mutations, coverage or source');
