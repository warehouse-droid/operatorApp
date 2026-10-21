import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

assert.equal(process.env.MBT_TEST_ISOLATED,'1');
const out='test-artifacts/receiving-multi-yard';
const manifest=JSON.parse(readFileSync('test/receiving-multi-yard-manifest.json','utf8'));
mkdirSync(out,{recursive:true});
for(const folder of ['coverage','c8']) {rmSync(`${out}/${folder}`,{recursive:true,force:true});}
const results=[];
const hash=file=>createHash('sha256').update(readFileSync(file)).digest('hex');
for(const file of manifest.runtimeFiles) {assert.equal(hash(file),manifest.after[file],file);}
if(process.argv.includes('--resume-full')) {
  const previous=JSON.parse(readFileSync(`${out}/source-state.json`,'utf8')).files;
  if(previous['src/server.js']!==manifest.after['src/server.js']) {
    const proof=JSON.parse(readFileSync('test/receiving-multi-yard-rebase-proof.json','utf8'));
    assert.equal(previous['src/server.js'],proof.oldServerHash);
    assert.equal(manifest.after['src/server.js'],proof.newServerHash);
    const server=readFileSync('src/server.js','utf8');
    assert.equal(server.split(proof.existingBaselineAddition).length,2);
    assert.equal(createHash('sha256').update(server.replace(proof.existingBaselineAddition,'')).digest('hex'),proof.oldServerHash,
      'Only the independently deployed SCM catalog fallback may differ; every receiving byte must remain unchanged.');
    previous['src/server.js']=proof.newServerHash;
    writeFileSync(`${out}/rebase-equivalence.json`,JSON.stringify(proof,null,2));
  }
  assert.deepEqual(previous,manifest.after,'Saved full-suite source must match all receiving files.');
}
writeFileSync(`${out}/source-state.json`,JSON.stringify({node:process.version,files:manifest.after},null,2));

function run(name,cmd,args,{cwd=process.cwd(),expected=0}={}) {
  const result=spawnSync(cmd,args,{cwd,encoding:'utf8',maxBuffer:90e6,timeout:2700000});
  if(result.error) {throw result.error;}
  const output=result.stdout+result.stderr;
  writeFileSync(`${out}/${name}.log`,output);
  assert.equal(result.status,expected,`${name}: ${output.slice(-1800)}`);
  results.push({name,exit:result.status});
  console.log(JSON.stringify(results.at(-1)));
  return output;
}

run('tool-versions',process.execPath,['tools/receiving-multi-yard-tool-versions.mjs']);

if(!process.argv.includes('--focused')) {
  const resumed=process.argv.includes('--resume-full');
  const result=resumed ? {status:null,stdout:readFileSync(`${out}/full-candidate.log`,'utf8'),stderr:''}
    : spawnSync('npm',['test'],{encoding:'utf8',maxBuffer:90e6,timeout:2700000});
  if(result.error) {throw result.error;}
  const output=result.stdout+result.stderr;
  if(!resumed) {writeFileSync(`${out}/full-candidate.log`,output);}
  const failures=text=>[...new Set([...text.matchAll(/^✖ (.+?) \([\d.]+ms\)/gm)].map(match=>match[1]))];
  const baseline=JSON.parse(readFileSync('test/receiving-multi-yard-full-baseline.json','utf8'));
  const current=failures(output);
  const added=current.filter(name=>!baseline.failures.includes(name));
  run('fixture-recheck',process.execPath,['tools/receiving-multi-yard-fixture-recheck.mjs']);
  run('full-comparison',process.execPath,['tools/receiving-multi-yard-full-compare.mjs']);
  const comparison=JSON.parse(readFileSync(`${out}/full-comparison.json`,'utf8'));
  assert.equal(comparison.newFailures.length,0,JSON.stringify(comparison.newFailures));
  const completed=[...output.matchAll(/MBT main (\d+)\/(\d+)/g)].at(-1);
  assert.ok(completed && completed[1]===completed[2],'The full suite must reach its last file.');
  const counts={passed:[...output.matchAll(/^ℹ pass (\d+)$/gm)].reduce((sum,row)=>sum+Number(row[1]),0),
    failed:[...output.matchAll(/^ℹ fail (\d+)$/gm)].reduce((sum,row)=>sum+Number(row[1]),0)};
  results.push({name:'full',exit:result.status,...counts,failures:current,newFailures:comparison.newFailures,
    rawAdditionalFailures:added,resumed,fixtureRechecks:comparison.fixtureRechecks});
  console.log(JSON.stringify({name:'full',...counts,newFailures:comparison.newFailures.length}));
}

run('static',process.execPath,['tools/receiving-multi-yard-static.mjs']);
const coverage=run('focused-coverage',path.resolve('node_modules/.bin/c8'),['--all=false','--check-coverage=false',
  ...manifest.runtimeFiles.filter(file=>file.endsWith('.js')).map(file=>`--include=${file}`),
  `--temp-directory=${out}/c8`,`--report-dir=${out}/coverage`,'--reporter=json','--reporter=json-summary','--reporter=text',
  process.execPath,'tools/receiving-multi-yard-focused.mjs']);
const totals={};
for(const [,key,value] of coverage.matchAll(/^ℹ (tests|pass|fail) (\d+)$/gm)) {totals[key]=(totals[key]||0)+Number(value);}
run('reversed',process.execPath,['tools/receiving-multi-yard-focused.mjs','--reverse']);

const coverageFiles=Object.values(JSON.parse(readFileSync(`${out}/coverage/coverage-final.json`,'utf8')));
const changed=[];
for(const file of manifest.runtimeFiles.filter(value=>value.endsWith('.js'))) {
  const measured=coverageFiles.find(value=>value.path.endsWith('/'+file));
  assert.ok(measured,file);
  for(const line of manifest.changedLines[file]) {
    const counts=Object.entries(measured.statementMap).filter(([,range])=>range.start.line<=line && range.end.line>=line)
      .map(([id])=>measured.s[id]);
    changed.push({file,line,count:Math.max(0,...counts)});
  }
}
const missing=changed.filter(row=>row.count===0);
writeFileSync(`${out}/changed-coverage.json`,JSON.stringify({covered:changed.length-missing.length,total:changed.length,missing,changed},null,2));
assert.equal(missing.length,0,JSON.stringify(missing));

const mutations=[
  ['header yard only','src/receiving-yard-scope.js','lines.map((/** @type {Record<string, any>} */ line) => lineYard(order, line))',
    'lines.map(() => normalizeOperatorNetSuiteLocationId(order.destination_location_id))',true],
  ['receive foreign confirmations','src/receiving-yard-scope.js','order.receivableLines.filter(selected)','order.receivableLines.slice()',true],
  ['drop rows that need explicit skip','src/receiving-yard-scope.js','lines: keepAllLines ?','lines: !keepAllLines ?',true],
  ['allow foreign line drafts','src/operator-yard-authorization.js',
    'if (ids.some((/** @type {any} */ id) => !own.has(String(id))))',
    'if (ids.some((/** @type {any} */ id) => false && !own.has(String(id))))',false],
  ['search uses header only','src/receiving-repository.js','${line}.location_id, ${order}.destination_location_id',
    '${order}.destination_location_id',false],
  ['lose the PO yard mismatch error contract','src/operator-netsuite-posting-targets.js',
    "'OPERATOR_NETSUITE_POSTING_LOCATION_MISMATCH'", "'RECEIVING_YARD_FORBIDDEN'",false]
];
const mutationResults=[];
for(const [index,[name,file,before,after,property]] of mutations.entries()) {
  const contents=readFileSync(file,'utf8');
  assert.equal(contents.split(before).length,2,name);
  const mutant=mkdtempSync(path.join(tmpdir(),'receiving-multiyard-mutant-'));
  try {
    for(const folder of ['src','public']) {cpSync(folder,path.join(mutant,folder),{recursive:true});}
    cpSync('package.json',path.join(mutant,'package.json'));
    symlinkSync(path.resolve('node_modules'),path.join(mutant,'node_modules'),'dir');
    for(const testFile of manifest.testFiles) {
      mkdirSync(path.dirname(path.join(mutant,testFile)),{recursive:true});
      cpSync(testFile,path.join(mutant,testFile));
    }
    cpSync('test/support/receiving-multi-yard-baseline',path.join(mutant,'test/support/receiving-multi-yard-baseline'),{recursive:true});
    writeFileSync(path.join(mutant,file),contents.replace(before,after));
    for(const layer of property?['focused','property']:['focused']) {
      const args=layer==='property'?['--test','--test-name-pattern=property:',manifest.testFiles[0]]
        :['--test','--test-concurrency=1',...manifest.testFiles];
      const output=run(`mutant-${index+1}-${layer}`,process.execPath,args,{cwd:mutant,expected:1});
      assert.match(output,/ERR_ASSERTION|Property failed after/);
      mutationResults.push({name,layer,killed:true});
    }
  } finally {rmSync(mutant,{recursive:true,force:true});}
}
writeFileSync(`${out}/mutations.json`,JSON.stringify(mutationResults,null,2));
run('secrets',process.execPath,['test/support/scan-diff-secrets.mjs',...manifest.runtimeFiles,...manifest.testFiles]);
for(const file of manifest.runtimeFiles.filter(value=>value.endsWith('.js'))) {run(`syntax-${path.basename(file)}`,process.execPath,['--check',file]);}
for(const file of manifest.runtimeFiles) {assert.equal(hash(file),manifest.after[file],file);}
const summary={passed:true,tests:totals,changedCoverage:{covered:changed.length,total:changed.length},
  focusedMutants:mutations.length,propertyMutants:mutationResults.filter(row=>row.layer==='property').length,
  properties:{seed:20260930,examples:120},static:JSON.parse(readFileSync(`${out}/static.json`,'utf8')),results};
writeFileSync(`${out}/gauntlet.json`,JSON.stringify(summary,null,2));
console.log(JSON.stringify(summary));
