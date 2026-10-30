import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {ESLint} from 'eslint';
import coverageLibrary from 'istanbul-lib-coverage';
import {query,closeDb} from '../src/db.js';
import {scanTextForSecrets} from '../test/support/scan-diff-secrets.mjs';

const root=process.cwd(),output=path.resolve('test-artifacts/checks');
fs.rmSync(output,{recursive:true,force:true});fs.mkdirSync(output,{recursive:true});
const changed=JSON.parse(fs.readFileSync('test-artifacts/changed-lines.json','utf8'));
const files=Object.keys(changed);
const primary=['test/mbt/unit/sales-delivery-load-fulfillment.test.js','test/mbt/integration/sales-delivery-load-fulfillment.test.js'];
const tests=[...new Set([...primary,...fs.readdirSync('test/mbt/unit').filter(name=>
  /^(operator-netsuite-posting-|operator-kit|operator-posting-(pack|rounding)|operator-linked-fulfillment|sales-order-auto-fulfillment|child-location-|noninventory-fulfillment|transfer-order-background-posting|ifir-posting)/.test(name)
  && name.endsWith('.test.js')).map(name=>`test/mbt/unit/${name}`),
  'test/mbt/unit/feature-gate-catalog.test.js','test/mbt/property/operator-linked-fulfillment.property.test.js',
  'test/mbt/property/operator-netsuite-posting.property.test.js','test/mbt/adversarial/operator-netsuite-posting-adversarial.test.js',
  'test/mbt/integration/sales-order-auto-fulfillment-migration.red.test.js',
  'test/mbt/integration/sales-order-auto-fulfillment-admin-http.test.js',
  'test/mbt/integration/feature-gate-admin-http.test.js','test/mbt/integration/movement-document-history.test.js',
  'test/mbt/integration/transfer-yard-posting.test.js'])];
const report={tools:{node:process.version},source:{},layers:{},mutants:[]};
for(const name of ['fast-check','typescript','eslint','c8']) {
  report.tools[name]=JSON.parse(fs.readFileSync(`node_modules/${name}/package.json`,'utf8')).version;
}
for(const file of [...files,'migrations/301_sales_order_operator_load_fulfillment.sql',...primary]) {
  report.source[file]=crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}
report.sourceStateSha256=crypto.createHash('sha256').update(JSON.stringify(Object.entries(report.source).sort())).digest('hex');
const baselineFailures=[];
function run(name,args,{cwd=root,allowed=[],expectFailure=false}={}) {
  const result=spawnSync(process.execPath,args,{cwd,encoding:'utf8',timeout:240000,maxBuffer:64*1024*1024});
  const text=`${result.stdout || ''}${result.stderr || ''}`;
  fs.writeFileSync(`${output}/${name}.log`,text);
  assert.equal(result.signal,null,`${name} terminated: ${result.error}`);
  const failures=[...text.matchAll(/^not ok \d+ - (.+)$/gm)].map(match=>match[1]);
  const summary={exit:result.status,tests:Number(text.match(/# tests (\d+)/)?.[1] || 0),
    passed:Number(text.match(/# pass (\d+)/)?.[1] || 0),failed:Number(text.match(/# fail (\d+)/)?.[1] || 0),failures};
  console.log(JSON.stringify({name,...summary}));
  if(expectFailure) {assert.ok(result.status===1 && summary.failed>0,`surviving mutant ${name}: ${text.slice(-3000)}`);}
  else {
    assert.ok(result.status===0 || (summary.failed===failures.length && failures.length>0
      && failures.every(value=>allowed.includes(value))),`${name}: ${text.slice(-14000)}`);
  }
  return summary;
}
function clone(destination,selectedTests=[]) {
  fs.mkdirSync(destination,{recursive:true});
  fs.cpSync('src',`${destination}/src`,{recursive:true});
  for(const name of ['node_modules','public','migrations','contracts']) {fs.symlinkSync(path.resolve(name),`${destination}/${name}`);}
  for(const name of ['package.json','.env.example']) {fs.copyFileSync(name,`${destination}/${name}`);}
  for(const file of selectedTests) {fs.mkdirSync(path.dirname(`${destination}/${file}`),{recursive:true});fs.copyFileSync(file,`${destination}/${file}`);}
}

report.layers.tests=run('fulfillment-regressions',['--test','--test-concurrency=1',...tests],{allowed:baselineFailures});
report.layers.order=run('reverse-file-order',['--test','--test-concurrency=1',...tests.toReversed()],{allowed:baselineFailures});
assert.deepEqual(report.layers.order.failures,report.layers.tests.failures);
report.layers.coverageRun=run('coverage',['node_modules/c8/bin/c8.js','--all=false','--check-coverage=false',
  ...files.map(file=>`--include=${file}`),`--temp-directory=${output}/c8`,`--report-dir=${output}/coverage`,
  '--reporter=json','--reporter=json-summary','node','--test','--test-concurrency=1',...tests],{allowed:baselineFailures});
const map=coverageLibrary.createCoverageMap(JSON.parse(fs.readFileSync(`${output}/coverage/coverage-final.json`,'utf8')));
const misses=[],covered=[];
for(const file of files) {
  const coverage=map.fileCoverageFor(path.resolve(file)).getLineCoverage();
  for(const line of changed[file]) {
    if(coverage[line]===undefined) {continue;}
    (coverage[line]>0?covered:misses).push(`${file}:${line}`);
  }
}
report.layers.changedLines={covered:covered.length,total:covered.length+misses.length,misses};
console.log(JSON.stringify({coverage:report.layers.changedLines}));
assert.deepEqual(misses,[],'Every changed executable line must have behavioral coverage.');

const baselineRoot=`${output}/baseline`;
clone(baselineRoot);
for(const file of files) {fs.copyFileSync(`test-artifacts/before/${file}`,`${baselineRoot}/${file}`);}
function diagnostics(cwd,baseline) {
  const checked=files.filter(file=>!baseline || fs.readFileSync(`test-artifacts/before/${file}`,'utf8').length>0);
  const result=spawnSync(process.execPath,['node_modules/typescript/bin/tsc','--noEmit','--allowJs','--checkJs',
    '--skipLibCheck','--module','nodenext','--target','es2022',...checked],{cwd,encoding:'utf8',timeout:180000,maxBuffer:64*1024*1024});
  assert.equal(result.signal,null);
  const text=`${result.stdout || ''}${result.stderr || ''}`;
  fs.writeFileSync(`${output}/types-${baseline?'before':'after'}.log`,text);
  return text.split('\n').filter(line=>files.some(file=>line.startsWith(`${file}(`)))
    .map(line=>line.replace(/\(\d+,\d+\)/g,''));
}
const typesBefore=diagnostics(baselineRoot,true),typesAfter=diagnostics(root,false);
report.layers.types={before:typesBefore.length,after:typesAfter.length,new:typesAfter.filter(value=>!typesBefore.includes(value))};
console.log(JSON.stringify({types:report.layers.types}));
assert.deepEqual(report.layers.types.new,[]);
const eslint=new ESLint({overrideConfigFile:'eslint.mbt.config.js'});
const lintBefore=[],lintAfter=[];
for(const file of files) {
  run(`syntax-${path.basename(file)}`,['--check',file]);
  assert.deepEqual(scanTextForSecrets(fs.readFileSync(file,'utf8'),file),[]);
  for(const [before,destination] of [[true,lintBefore],[false,lintAfter]]) {
    const source=fs.readFileSync(before?`test-artifacts/before/${file}`:file,'utf8');
    if(!source) {continue;}
    const [result]=await eslint.lintText(source,{filePath:file});
    destination.push(...result.messages.map(message=>JSON.stringify({file,rule:message.ruleId,message:message.message})));
  }
}
report.layers.lint={before:lintBefore.length,after:lintAfter.length,new:lintAfter.filter(value=>!lintBefore.includes(value))};
console.log(JSON.stringify({lint:report.layers.lint}));
assert.deepEqual(report.layers.lint.new,[]);

const mutantRoot=`${output}/mutant`;
clone(mutantRoot,primary);
const mutants=[
  ['quantity-inflated','src/sales-order-auto-fulfillment-loads.js','const amount=Number(retained.quantity);','const amount=Number(retained.quantity)+1;'],
  ['wrong-item-accepted','src/sales-order-auto-fulfillment-loads.js','&& Number(line.item_id)===Number(retained.itemId)','&& true'],
  ['unloaded-lines-block-load','src/sales-order-auto-fulfillment-service.js','candidate.isSplit || candidate.operatorLoadRecordId','candidate.isSplit'],
  ['gate-disabled-posts','src/sales-order-auto-fulfillment-repository.js','AND flag.enabled = true','AND true'],
  ['legacy-noninventory-not-skipped','src/sales-order-auto-fulfillment-repository.js','if (!lines.length && allLines.length)', 'if (false && allLines.length)']
];
for(const [name,file,before,after] of mutants) {
  const original=fs.readFileSync(`${mutantRoot}/${file}`,'utf8');
  assert.equal(original.split(before).length,2,`mutant anchor ${name}`);
  fs.writeFileSync(`${mutantRoot}/${file}`,original.replace(before,after));
  try {
    run(name,['--test','--test-concurrency=1',...primary],{cwd:mutantRoot,expectFailure:true});
    const property=spawnSync(process.execPath,['--test','--test-name-pattern=^property:',primary[0]],
      {cwd:mutantRoot,encoding:'utf8',timeout:30000});
    report.mutants.push({name,killed:true,propertyOnlyKilled:property.status===1});
  } finally {fs.writeFileSync(`${mutantRoot}/${file}`,original);}
}
const migration=fs.readFileSync('migrations/301_sales_order_operator_load_fulfillment.sql','utf8');
const functionSql=migration.slice(migration.indexOf('CREATE OR REPLACE FUNCTION operator_enqueue'),migration.indexOf('CREATE TRIGGER trg_operator_enqueue'));
try {
  await query(functionSql.replace('-COALESCE(previous.quantity,0)','-0'));
  run('cumulative-total-reposted',['--test','--test-concurrency=1',primary[1]],{expectFailure:true});
  report.mutants.push({name:'cumulative-total-reposted',killed:true});
} finally {await query(functionSql);}
try {
  await query(`CREATE TRIGGER trg_dispatch_enqueue_sales_order_if_candidate AFTER INSERT ON dispatch_order_completion_events
    FOR EACH ROW EXECUTE FUNCTION dispatch_enqueue_sales_order_if_candidate()`);
  run('driver-requeues-fulfillment',['--test','--test-concurrency=1',primary[1]],{expectFailure:true});
  report.mutants.push({name:'driver-requeues-fulfillment',killed:true});
} finally {
  await query('DROP TRIGGER IF EXISTS trg_dispatch_enqueue_sales_order_if_candidate ON dispatch_order_completion_events');
  await closeDb();
}
report.layers.restored=run('restored-source',['--test','--test-concurrency=1',...primary]);
for(const [file,expected] of Object.entries(report.source)) {
  assert.equal(crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'),expected);
}
fs.writeFileSync(`${output}/report.json`,JSON.stringify(report,null,2));
console.log(`SO_LOAD_REPORT ${JSON.stringify(report)}`);
