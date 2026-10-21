import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {readFile,writeFile} from 'node:fs/promises';
import {openSync,closeSync} from 'node:fs';
import {ESLint} from 'eslint';
const mode=process.argv[2],layers=[];
assert.equal(process.env.MBT_TEST_ISOLATED,'1');
const files=['public/backorder-stock-requests.js','public/special-stock-workflow.js','public/scm-special-stock-requests.js','src/special-stock-request-repository.js','src/server.js'];
const suite=[
  'unit/special-customer-confirmation.test.js','unit/special-po-dispatch-stage.test.js',
  'unit/special-workflow-enquiry.test.js','unit/special-workflow-review.test.js','unit/special-case-edits.test.js',
  'property/special-stock-request-domain.property.test.js','property/backorder-link-sequence.property.test.js',
  'integration/special-customer-confirmation.test.js','integration/special-po-dispatch-stage.test.js',
  'integration/special-custom-po-http.test.js','integration/special-manual-so-link.test.js','integration/backorder-requests.test.js'
].map(n=>'test/mbt/'+n);
const newTests=['test/mbt/property/special-vendor-confirmation.property.test.js','test/mbt/integration/special-vendor-confirmation.test.js'];
async function run(name,args,options={}) {
  const fd=openSync('test-artifacts/'+name+'.log','w');let result;
  try{result=spawnSync(process.execPath,args,{stdio:['ignore',fd,fd],timeout:600000,...options});}finally{closeSync(fd);}
  const output=await readFile('test-artifacts/'+name+'.log','utf8');
  const count=key=>Number(output.match(new RegExp('^# '+key+' (\\d+)$','m'))?.[1]||0);
  const record={name,exitCode:result.status,tests:count('tests'),passed:count('pass'),failed:count('fail'),failures:[...output.matchAll(/^not ok \d+ - (.+)$/gm)].map(m=>m[1])};
  layers.push(record);console.log(JSON.stringify(record));assert.equal(result.signal,null);return {record,output};
}
if(mode==='finish'){await finish(JSON.parse(await readFile('test-artifacts/report.json','utf8')));process.exit(0);}
const grouped={db:[],alias:[]};
for(const file of mode==='baseline-static'?[]:mode==='propertyred'?newTests.slice(0,1):['red','focused'].includes(mode)?newTests:[...suite,...(mode==='final'?newTests:[])]) {
  const content=await readFile(file,'utf8');grouped[content.includes("hostname, 'mbbs-special-review-db'")||content.includes("hostname,'mbbs-special-review-db'")?'alias':'db'].push(file);
}
const coverageArgs=['node_modules/c8/bin/c8.js','--all=false','--clean=false',...files.map(n=>'--include='+n),'--check-coverage=false','--reporter=json','--report-dir=test-artifacts/coverage','--temp-directory=/tmp/special-vendor-c8','node'];
for(const [group,tests] of Object.entries(grouped))if(tests.length) {
  const url=new URL(process.env.DATABASE_URL);if(group==='alias')url.hostname='mbbs-special-review-db';
  await run('suite-'+group,[...(mode==='final'?coverageArgs:[]),'--test','--test-concurrency=1',...tests],{env:{...process.env,DATABASE_URL:url.href}});
}
if(mode==='propertyred'){assert.ok(layers.some(l=>l.failed>0));process.exit(0);}
if(mode==='focused'){assert.ok(layers.every(l=>l.exitCode===0));process.exit(0);}
const types=await run('types',['node_modules/typescript/bin/tsc','--allowJs','--checkJs','--noEmit','--skipLibCheck','--module','nodenext','--target','es2023','--lib','es2023,dom,dom.iterable',...files]);
const typeDiagnostics=[...types.output.matchAll(/^(.+?)\(\d+,\d+\): (error TS\d+: .+)$/gm)].map(m=>m[1]+': '+m[2]);
const eslint=new ESLint({overrideConfigFile:'tools/regular-stock-v2-eslint.config.mjs'});
const lintDiagnostics=(await eslint.lintFiles(files)).flatMap(r=>r.messages.map(({ruleId,severity,message})=>({file:r.filePath.replace(process.cwd()+'/',''),ruleId,severity,message})));
const report={mode,layers,suite,regressionFailures:layers.filter(l=>l.name.startsWith('suite')).flatMap(l=>l.failures),typeDiagnostics,lintDiagnostics};
report.toolchain={node:process.version};for(const name of ['fast-check','typescript','eslint','c8','@playwright/test'])report.toolchain[name]=JSON.parse(await readFile('node_modules/'+name+'/package.json','utf8')).version;
await writeFile('test-artifacts/report.json',JSON.stringify(report,null,2));
if(mode==='red')assert.ok(report.regressionFailures.length,'New behavior must fail before implementation');
if(mode==='final') {
  const baseline=JSON.parse(await readFile('/evidence/baseline/report.json','utf8'));
  const added=(current,previous)=>{const left=previous.map(x=>JSON.stringify(x));return current.filter(x=>{const i=left.indexOf(JSON.stringify(x));if(i<0)return true;left.splice(i,1);return false;});};
  const baselineNames=baseline.regressionFailures.map(name=>name.replace('are Confirmed everywhere','await the SO everywhere'));
  report.newFailures=added(report.regressionFailures,baselineNames);
  const staticBaseline=JSON.parse(await readFile('/evidence/baseline-static/report.json','utf8'));
  report.newTypes=added(typeDiagnostics,staticBaseline.typeDiagnostics);report.newLint=added(lintDiagnostics,staticBaseline.lintDiagnostics);
  await writeFile('test-artifacts/report.json',JSON.stringify(report,null,2));
  assert.deepEqual(report.newFailures,[]);assert.deepEqual(report.newTypes,[]);assert.deepEqual(report.newLint,[]);
  await finish(report);
}

async function finish(report) {
  assert.deepEqual(report.newFailures,[]);assert.deepEqual(report.newTypes,[]);assert.deepEqual(report.newLint,[]);
  const property=await run('property-repeat',['--test','test/mbt/property/special-vendor-confirmation.property.test.js','test/mbt/property/backorder-link-sequence.property.test.js']);assert.equal(property.record.exitCode,0);
  const mutants=await run('mutations',['tools/special-vendor-confirmation-20261016/mutate.mjs']);assert.equal(mutants.record.exitCode,0);
  const coverage=await run('changed-coverage',['tools/special-vendor-confirmation-20261016/coverage.mjs']);assert.equal(coverage.record.exitCode,0);
  report.coverage=JSON.parse(await readFile('test-artifacts/changed-coverage.json','utf8'));
  report.source=JSON.parse(await readFile('test-artifacts/source.json','utf8'));report.spec=JSON.parse(await readFile('tools/special-vendor-confirmation-20261016/spec.json','utf8'));
  assert.doesNotMatch(await readFile('/release/feature.patch','utf8'),/AKIA[0-9A-Z]{16}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|ghp_[A-Za-z0-9]{36}/);
  report.limits={suite:'All directly affected workflow stage, SO/PO link, backorder request and property suites plus authenticated browser/API acceptance. Repository-wide unrelated subsystem suites are outside this change.',staticAnalysis:'Existing errors retained; no new diagnostics.',dependencies:'No dependencies or remote integrations added.',performance:'One row-locked acknowledgement transaction. No remote call. No benchmark required.',productionBusinessWrites:'Only synthetic disposable records exercised by tests.',baselineFailure:'Legacy customer confirmation test still expects a fixed transfer date, whereas current live policy derives ETA from SO placement. The renamed test retains the same failing assertion.'};
  if(report.layers!==layers)report.layers.push(...layers);
  report.passed=true;await writeFile('test-artifacts/report.json',JSON.stringify(report,null,2));
}
