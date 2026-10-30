import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
const root=process.cwd(),output=path.resolve('test-artifacts/stock-exchange');
fs.mkdirSync(output,{recursive:true});
const modules=['domain','netsuite','proof','service'].map(name=>`src/stock-exchange-${name}.js`);
const tests=['test/mbt/unit/stock-exchange.test.js','test/mbt/unit/stock-exchange-posting.test.js','test/mbt/integration/stock-exchange.test.js'];
const policyTests=['test/mbt/unit/feature-gate-catalog.test.js','test/mbt/unit/operator-netsuite-posting-policy.red.test.js',
  'test/mbt/integration/operator-netsuite-posting-policy-repository.red.test.js','test/mbt/integration/feature-gate-admin-http.test.js'];
const nodeTests=['--test','--test-concurrency=1'];
const changed=[...modules,...tests,...policyTests,'migrations/323_stock_exchange.sql','src/return-repository.js','src/operator-netsuite-posting-policy.js',
  'src/mbt/feature-gate-catalog.js','src/history-repository.js','src/server.js','public/operator.js','public/control.js','public/sales.js','public/i18n.js',
  'test/mbt/unit/return-ra-client.test.js','tools/stock-exchange-checks.mjs','tools/stock-exchange-browser.mjs','tools/stock-exchange-eslint.config.mjs'];
const featureHash=()=>createHash('sha256').update(changed.map(file=>file+':'+createHash('sha256').update(fs.readFileSync(file)).digest('hex')).join('\n')).digest('hex');
const initialHash=featureHash();
const baselineArgument=process.argv.find(value=>value.startsWith('--return-baseline='));
const returnBaseline=baselineArgument?JSON.parse(baselineArgument.slice('--return-baseline='.length)):null;
if(returnBaseline){
  assert.equal(returnBaseline.testFile,'test/mbt/integration/return-pallet-saved-search.test.js');
  assert.equal(createHash('sha256').update(fs.readFileSync(returnBaseline.testFile)).digest('hex'),returnBaseline.testHash);
  assert.equal(returnBaseline.failedTests.length,2);
}
const baselineFailures=[];
function assertOrdinaryResult(name,result,outputText,knownFailures=[]){
  const failures=outputText.split(/(?=# Subtest: )/).filter(part=>/^not ok /m.test(part)).join('\n');
  if(result.status!==0&&knownFailures.length){
    const names=[...outputText.matchAll(/^not ok \d+ - (.+)$/gm)].map(match=>match[1]);
    assert.deepEqual(names.toSorted(),knownFailures.toSorted(),`${name}: new failures\n${failures.slice(0,18000)}`);
    assert.match(outputText,/# cancelled 0/);assert.match(outputText,new RegExp(`# fail ${knownFailures.length}\\b`));
    baselineFailures.push(...names);
  }else{assert.equal(result.status,0,`${name}:\n${failures.slice(0,18000)}\n${outputText.slice(-3000)}`);}
}
function run(name,args,{cwd=root,fails=false,knownFailures}={}) {
  const result=spawnSync(process.execPath,args,{cwd,encoding:'utf8',timeout:240000,maxBuffer:25e6});
  const outputText=(result.stdout||'')+(result.stderr||'');
  fs.writeFileSync(path.join(output,`${name}.log`),outputText);
  assert.ifError(result.error);
  if(fails){assert.notEqual(result.status,0,`${name} survived`);assert.match(outputText,/not ok/);
    assert.doesNotMatch(outputText,/ERR_MODULE_NOT_FOUND|ENOENT/);console.log(outputText.match(/^not ok.*$/m)?.[0]);}
  else {assertOrdinaryResult(name,result,outputText,knownFailures);}
  console.log(`${name}: ${fails?'killed':result.status===0?'passed':`${knownFailures.length} unchanged baseline failures; no new failures`} ${outputText.match(/# tests \d+/)?.[0]||''}`);
  return outputText;
}
if(process.argv.includes('--acceptance')){run('acceptance',[...nodeTests,...tests]);process.exit(0);}
if(process.argv.includes('--gates')){run('posting-gates',[...nodeTests,...policyTests]);process.exit(0);}
if(process.argv.includes('--lint')){run('lint',['node_modules/eslint/bin/eslint.js','--config','tools/stock-exchange-eslint.config.mjs','--max-warnings=0',...modules,...tests,'tools/stock-exchange-checks.mjs','tools/stock-exchange-browser.mjs']);process.exit(0);}
if(!process.argv.includes('--regressions')){run('acceptance',[...nodeTests,...tests]);}
const regressions=['unit','integration'].flatMap(group=>fs.readdirSync(`test/mbt/${group}`)
  .filter(name=>/^return-.*\.test\.js$/.test(name)).map(name=>`test/mbt/${group}/${name}`));
run('return-regressions',[...nodeTests,...regressions,'test/mbt/integration/stock-return-draft-insert.test.js'],{knownFailures:returnBaseline?.failedTests||[]});
if(process.argv.includes('--regressions')){process.exit(0);}
run('posting-gates',[...nodeTests,...policyTests]);
run('lint',['node_modules/eslint/bin/eslint.js','--config','tools/stock-exchange-eslint.config.mjs','--max-warnings=0',...modules,...tests,'tools/stock-exchange-checks.mjs','tools/stock-exchange-browser.mjs']);
for(const file of [...modules,'src/server.js','src/return-repository.js','src/history-repository.js','src/operator-netsuite-posting-policy.js',
  'src/mbt/feature-gate-catalog.js','public/operator.js','public/control.js','public/sales.js','public/i18n.js']){run(`syntax-${path.basename(file)}`,['--check',file]);}
run('types',['node_modules/typescript/bin/tsc','--allowJs','--checkJs','false','--noEmit','--skipLibCheck','--target','es2023','--module','nodenext','--types','node','src/stock-exchange-domain.js']);
run('browser',['tools/stock-exchange-browser.mjs']);
run('coverage',['node_modules/c8/bin/c8.js','--all=false','--include=src/stock-exchange-*.js',`--temp-directory=${output}/c8`,
  `--report-dir=${output}/coverage`,'--reporter=text','--reporter=json-summary','node',...nodeTests,...tests]);
run('reverse-order',[...nodeTests,...tests.toReversed()]);
const {scanTextForSecrets}=await import('../test/support/scan-diff-secrets.mjs');
assert.deepEqual([...modules,...tests].flatMap(file=>scanTextForSecrets(fs.readFileSync(file,'utf8'),file)),[]);
console.log('secrets: passed; no new dependencies');
const mutants=[
  ['quantity','src/stock-exchange-domain.js','adjustQtyBy: quantity','adjustQtyBy: quantity + 1',tests[0]],
  ['reason','src/stock-exchange-domain.js','if (![5,6,7,8,9].includes(reason))','if (false)',tests[0]],
  ['month','src/stock-exchange-domain.js','MONTHS[Number(part)-1]','MONTHS[Number(part)%12]',tests[0]],
  ['position','src/stock-exchange-domain.js','custcol_position: so','custcol_position: "WRONG"',tests[0]],
  ['retry','src/stock-exchange-service.js','if(uncertain) {throw','if(false) {throw',tests[2]]
];
const scratch=path.join(output,'mutant');
try{
  for(const dir of ['src','public','test']){fs.cpSync(dir,path.join(scratch,dir),{recursive:true});}
  fs.copyFileSync('package.json',path.join(scratch,'package.json'));
  fs.symlinkSync(path.join(root,'migrations'),path.join(scratch,'migrations'),'dir');
  fs.symlinkSync(path.join(root,'node_modules'),path.join(scratch,'node_modules'),'dir');
  for(const [name,file,anchor,replacement,target]of mutants){
    const destination=path.join(scratch,file),source=fs.readFileSync(destination,'utf8');assert.ok(source.includes(anchor),name);
    fs.writeFileSync(destination,source.replace(anchor,replacement));
    try{run(`mutation-${name}`,[...nodeTests,target],{cwd:scratch,fails:true});
      if(target===tests[0]){run(`property-mutation-${name}`,[...nodeTests,'--test-name-pattern=exchange.*property',target],{cwd:scratch,fails:true});}}
    finally{fs.writeFileSync(destination,source);}
  }
}finally{fs.rmSync(scratch,{recursive:true,force:true});}
const coverage=JSON.parse(fs.readFileSync(path.join(output,'coverage/coverage-summary.json'),'utf8'));
assert.equal(featureHash(),initialHash,'Feature source changed during validation; rerun against the final source.');
console.log(JSON.stringify({node:process.version,regressionFiles:regressions.length+1,baselineFailures,mutants:mutants.length,coverage:coverage.total,
  tools:Object.fromEntries(['eslint','typescript','c8','fast-check','@playwright/test'].map(name=>[name,JSON.parse(fs.readFileSync(`node_modules/${name}/package.json`,'utf8')).version])),
  sourceHash:initialHash}));
