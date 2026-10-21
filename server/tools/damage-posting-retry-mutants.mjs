import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync,cpSync,symlinkSync,mkdtempSync,rmSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
assert.equal(process.env.MBT_TEST_ISOLATED,'1');assert.equal(process.env.NETSUITE_DIRECT_ACCESS_ENABLED,'false');
const out=resolve('test-artifacts/damage-posting-retry-20261001');mkdirSync(out,{recursive:true});
const mutants=[
  ['receipt ownership','src/inventory-damage-posting-proof.js','record.memo!==proof.memo','false','test/damage-posting-proof.test.js','properties'],
  ['changed prior line','src/inventory-damage-posting-proof.js','Object.keys(snapshot).some(key=>snapshot[key]!==before[key])','false','test/damage-posting-proof.test.js','properties'],
  ['wrong new quantity','src/inventory-damage-posting-proof.js','Math.abs(current.quantity-Number(report.quantity))<=1e-6','true','test/damage-posting-proof.test.js','properties'],
  ['omitted REST receipt','src/inventory-damage-netsuite.js','...(memo===undefined?{}:{memo})','...{}','test/damage-posting-proof.test.js','REST append'],
  ['forgot draft save','public/damage-draft-cache.js','store.put(snapshot,id)','store.get(id)','test/damage-retained-retry-browser.test.js','entered quantity'],
  ['resend superseded report','src/inventory-damage-service.js',"['posted','superseded']","['posted']",'test/damage-posting-retry.test.js','superseded'],
  ['Control wrong quantity','src/control-damage-domain.js','Math.abs(Number(line.adjustQtyBy)-expected.adjustQtyBy)<1e-6','true','test/damage-control-confirmation.test.js','properties'],
  ['continued wrong yard upload','public/operator-inventory.js','await stashDraft(key,state);\n          if(!sameContext(key)) {return;}','await stashDraft(key,state);','test/damage-retained-retry-browser.test.js','changing yard during upload']
];
const files=JSON.parse(readFileSync('tools/damage-posting-retry-files.json'));
const hashes=()=>Object.fromEntries(files.map(file=>[file,createHash('sha256').update(readFileSync(file)).digest('hex')]));
const before=hashes(),results=[];
const temp=mkdtempSync(join(tmpdir(),'damage-retry-mutants-'));
try {
  for(const folder of ['src','public','test'])cpSync(folder,join(temp,folder),{recursive:true});
  mkdirSync(join(temp,'test-artifacts'),{recursive:true});
  cpSync('package.json',join(temp,'package.json'));symlinkSync(resolve('node_modules'),join(temp,'node_modules'),'dir');
  for(const [name,file,original,replacement,test,pattern] of mutants) {
    const path=join(temp,file),source=readFileSync(file,'utf8');assert.ok(source.includes(original),name+' target missing');
    const changed=source.replaceAll(original,replacement);assert.notEqual(changed,source);
    writeFileSync(path,changed);
    const run=spawnSync(process.execPath,['--test',`--test-name-pattern=${pattern}`,test],{cwd:temp,encoding:'utf8',timeout:45000,maxBuffer:3*1024*1024});
    writeFileSync(path,source);
    const log=(run.stdout || '')+(run.stderr || '');writeFileSync(join(out,'mutant-'+results.length+'.log'),log);
    const killed=run.status===1 && /^not ok /m.test(log) && !/SyntaxError|Cannot find module/.test(log);
    results.push({name,killed,exitCode:run.status,test,pattern});assert.ok(killed,name+' survived: '+log.slice(-2000));
  }
} finally {rmSync(temp,{recursive:true,force:true});assert.deepEqual(hashes(),before);writeFileSync(join(out,'mutations.json'),JSON.stringify(results,null,2));}
console.log(JSON.stringify({mutants:results.length,killed:results.filter(row=>row.killed).length,results}));
