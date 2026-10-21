import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {readdir,readFile,writeFile} from 'node:fs/promises';
import {openSync,closeSync} from 'node:fs';
import {ESLint} from 'eslint';

assert.equal(process.env.MBT_TEST_ISOLATED,'1');
const mode=process.argv[2],layers=[];
const files=['public/backorder-workflow.js'];
async function run(name,args,options={}) {
  const log=openSync(`test-artifacts/${name}.log`,'w');
  let result;
  try{result=spawnSync(process.execPath,args,{stdio:['ignore',log,log],timeout:600000,...options});}
  finally{closeSync(log);}
  const output=await readFile(`test-artifacts/${name}.log`,'utf8');
  const count=label=>Number(output.match(new RegExp('^# '+label+' (\\d+)$','m'))?.[1]||0);
  const record={name,exitCode:result.status,tests:count('tests'),passed:count('pass'),failed:count('fail'),failures:[...output.matchAll(/^not ok \d+ - (.+)$/gm)].map(m=>m[1])};
  layers.push(record);console.log(JSON.stringify(record));assert.equal(result.signal,null,name+' timed out');return {record,output};
}
const suite=[];
for(const dir of ['unit','property','integration'])for(const name of await readdir('test/mbt/'+dir)) {
  if(/^(backorder-|stocking-backorder-)/.test(name)&&name.endsWith('.test.js'))suite.push(`test/mbt/${dir}/${name}`);
}
suite.push('test/mbt/integration/special-manual-so-link.test.js');
const purchaseSuite='test/mbt/integration/special-po-unsubmitted-link-http.test.js';
const focused=['test/mbt/property/backorder-po-recheck.property.test.js','test/mbt/integration/backorder-requests.test.js','test/mbt/integration/backorder-browser.test.js'];
const testArgs=['--test','--test-concurrency=1',...(mode==='red'?['--test-name-pattern=PO recheck']:[]),...(mode==='red'?focused:suite)];
const coverageArgs=['node_modules/c8/bin/c8.js','--all=false',...files.map(n=>'--include='+n),'--check-coverage=false','--reporter=json','--report-dir=test-artifacts/coverage','--temp-directory=/tmp/backorder-po-recheck-c8','node'];
const regression=await run('suite',mode==='final'?[...coverageArgs,...testArgs]:testArgs);
const types=await run('types',['node_modules/typescript/bin/tsc','--allowJs','--checkJs','--noEmit','--skipLibCheck','--module','nodenext','--target','es2023','--lib','es2023,dom,dom.iterable',...files]);
const diagnostics=[...types.output.matchAll(/^(.+?)\(\d+,\d+\): (error TS\d+: .+)$/gm)].map(m=>m[1]+': '+m[2]);
const lint=new ESLint({overrideConfigFile:'tools/regular-stock-v2-eslint.config.mjs'});
const lintResults=await lint.lintFiles(files);
const lintDiagnostics=lintResults.flatMap(e=>e.messages.map(({ruleId,severity,message})=>({file:e.filePath.replace(process.cwd()+'/',''),ruleId,severity,message})));
await writeFile('test-artifacts/lint.json',JSON.stringify(lintDiagnostics,null,2));
const added=(current,previous)=>{const remaining=previous.map(x=>JSON.stringify(x));return current.filter(x=>{const i=remaining.indexOf(JSON.stringify(x));if(i<0)return true;remaining.splice(i,1);return false;});};
const report={mode,layers,suite,regressionFailures:regression.record.failures,typeDiagnostics:diagnostics,lintDiagnostics};
report.toolchain={node:process.version};
for(const name of ['fast-check','typescript','eslint','c8','@playwright/test'])report.toolchain[name]=JSON.parse(await readFile('node_modules/'+name+'/package.json','utf8')).version;
await writeFile('test-artifacts/report.json',JSON.stringify(report,null,2));
if(mode==='red')assert.ok(regression.record.failed>0,'New behavior must fail before implementation');
if(mode==='final') {
  const baseline=JSON.parse(await readFile('/evidence/baseline/report.json','utf8'));
  assert.deepEqual(added(report.regressionFailures,baseline.regressionFailures),[],'No new regression failures');
  assert.deepEqual(added(diagnostics,baseline.typeDiagnostics),[],'No new type errors');
  assert.deepEqual(added(lintDiagnostics,baseline.lintDiagnostics),[],'No new lint errors');
  // This legacy suite requires its own isolated DB hostname; it aliases the same
  // disposable Compose database and still receives only test credentials.
  const database=new URL(process.env.DATABASE_URL);database.hostname='mbbs-special-review-db';
  const purchase=await run('special-po-links',['--test',purchaseSuite],{env:{...process.env,DATABASE_URL:database.href}});
  assert.equal(purchase.record.exitCode,0);
  report.suite.push(purchaseSuite);
  const coverage=JSON.parse(await readFile('test-artifacts/coverage/coverage-final.json','utf8'));
  const changes=JSON.parse(await readFile('/release/changed-lines.json','utf8'));
  report.coverage={lines:0,covered:0,uncovered:[]};
  for(const [file,lines] of Object.entries(changes))for(const line of lines){
    const entry=coverage['/app/'+file];
    const executed=entry&&Object.entries(entry.statementMap).some(([id,range])=>range.start.line<=line&&range.end.line>=line&&entry.s[id]>0);
    report.coverage.lines++;if(executed)report.coverage.covered++;else report.coverage.uncovered.push(file+':'+line);
  }
  assert.deepEqual(report.coverage.uncovered,[],'Changed lines must execute');
  const shuffled=await run('property-order',['--test',...suite.filter(n=>n.includes('/property/')).reverse()]);
  assert.equal(shuffled.record.exitCode,0);
  const mutations=await run('mutations',['tools/backorder-po-recheck-20261019/mutate.mjs']);
  assert.equal(mutations.record.exitCode,0);
  const patch=await readFile('/release/feature.patch','utf8');
  assert.doesNotMatch(patch,/AKIA[0-9A-Z]{16}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|ghp_[A-Za-z0-9]{36}|sk-proj-[A-Za-z0-9_-]{30,}/);
  report.diffReview={secretPatternScan:'passed',newDependencies:0,newNetworkFilesystemOrSubprocessCapabilities:0};
  report.spec=JSON.parse(await readFile('tools/backorder-po-recheck-20261019/spec.json','utf8'));
  report.source=JSON.parse(await readFile('test-artifacts/source.json','utf8'));
  report.acceptance=[
    'PO recheck restores SCM PO controls after an SO link without changing Sales decisions',
    'PO recheck requires a linked SO and current stock review for pending materials',
    'PO recheck keeps closed cases and existing PO links out of the form',
    'PO recheck allows SCM reference linking after SO and repeated stock updates',
    'PO recheck keeps missing review and explicit Sales update guards on an SO-linked case',
    'PO recheck restores the SCM field and button and submits the existing PO in the browser'
  ].map(name=>({name,passed:regression.output.split('\n').some(line=>line.startsWith('ok ')&&line.endsWith(' - '+name))}));
  assert.ok(report.acceptance.every(item=>item.passed),'All acceptance scenarios must pass');
  report.limits={
    repositoryWideSuite:'Not run: scope is the complete Backorder/stocking-conversion suite plus shared manual order-link regressions, rather than unrelated application subsystems.',
    existingFailures:report.regressionFailures,
    staticAnalysis:'Compare diagnostics with the captured baseline; pre-existing type/lint errors remain outside scope.',
    dependencyAudit:'Not applicable: no dependencies changed.',
    performance:'No benchmark required: the same linear material scan; no new remote calls or queries.',
    productionBusinessWrites:'Not exercised: realistic authenticated HTTP and browser actions use synthetic data in the disposable database.'
  };
  report.passed=true;
  await writeFile('test-artifacts/report.json',JSON.stringify(report,null,2));
}
