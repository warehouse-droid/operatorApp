import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {readFileSync,writeFileSync,readdirSync,mkdirSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {buildIsolatedTestEnvironment} from '../test/support/test-foundation.mjs';
import {runNodeTestFilesIsolated} from '../test/support/test-database-isolation.mjs';

assert.equal(process.env.MBT_TEST_ISOLATED,'1');
const measured=['src/delivery-request-documents.js','src/netsuite-order-pdf.js','src/netsuite.js',
  'netsuite-smart-scm-picking-ticket-restlet.js','netsuite-transaction-pdf-suitelet.js'];
if(!process.env.ESTB_QUOTE_COVERAGE_CHILD) {
  const result=spawnSync('node_modules/.bin/c8',['--config=tools/delivery-request-c8.json','--all=false','--check-coverage=false',
    ...measured.map(file=>`--include=${file}`),'--temp-directory=test-artifacts/c8','--report-dir=test-artifacts/coverage',
    '--reporter=json','--reporter=text-summary',process.execPath,'tools/delivery-estb-quote-check.mjs'],{
    stdio:'inherit',env:{...process.env,ESTB_QUOTE_COVERAGE_CHILD:'1'}});
  if(result.status!==0) {process.exit(result.status || 1);}
  const coverage=spawnSync(process.execPath,['tools/delivery-estb-quote-coverage.mjs'],{stdio:'inherit'});
  process.exit(coverage.status || 0);
}
const tests=['unit','property','integration'].flatMap(kind=>readdirSync(`test/mbt/${kind}`)
  .filter(name=>/^(delivery-request|delivery-timeslot).*\.test\.js$/u.test(name)).sort().map(name=>`test/mbt/${kind}/${name}`));
tests.push('test/mbt/unit/delivery-estb-pdf.test.js','test/mbt/unit/special-workflow-native-documents.test.js',
  'test/mbt/unit/special-native-po-restlet.test.js','test/mbt/unit/special-workflow-adjustment-restlet.test.js',
  'test/mbt/integration/delivery-instruction-repository.test.js','test/mbt/integration/delivery-instruction-http.test.js');
mkdirSync('test-artifacts/delivery-requests-ui',{recursive:true});
const stages=[];
function run(name,binary,args,environment=process.env) {
  const result=spawnSync(binary,args,{encoding:'utf8',env:environment,timeout:300000,maxBuffer:32*1024*1024});
  const log=(result.stdout || '')+(result.stderr || '');writeFileSync(`test-artifacts/${name}.log`,log);
  stages.push({name,exitCode:result.status});writeFileSync('test-artifacts/layers.json',JSON.stringify(stages,null,2)+'\n');
  if(result.status!==0) {process.stdout.write(log.slice(-9000));throw new Error(`${name} failed with ${result.status}`);}
  process.stdout.write(`${name}: passed\n`);
}
run('types',process.execPath,['node_modules/typescript/bin/tsc','--noEmit','--allowJs','--checkJs','--strict','--skipLibCheck',
  '--types','node','--target','ES2022','--module','NodeNext','src/netsuite-order-pdf.js']);
run('domain-types',process.execPath,['tools/delivery-request-quality.mjs','types']);
const lintFiles=['src/delivery-request-documents.js','src/netsuite-order-pdf.js','public/delivery-requests.js','netsuite-transaction-pdf-suitelet.js',
  'test/mbt/unit/delivery-request-documents.test.js','test/mbt/unit/delivery-estb-pdf.test.js','test/mbt/integration/delivery-request-enhancements-browser.test.js',
  ...readdirSync('tools').filter(name=>/^delivery-estb-quote.*\.mjs$/u.test(name)).map(name=>`tools/${name}`)];
run('lint',process.execPath,['node_modules/eslint/bin/eslint.js','--config','tools/delivery-estb-quote-eslint.config.mjs','--max-warnings=0',...lintFiles]);
run('restlet-lint',process.execPath,['node_modules/eslint/bin/eslint.js','--config','tools/special-workflow-native-eslint.config.mjs','--max-warnings=0','netsuite-smart-scm-picking-ticket-restlet.js']);
for(const file of [...measured,'public/delivery-requests.js']) {run(`syntax-${file.split('/').at(-1)}`,process.execPath,['--check',file]);}
let seed=14102026;
for(let index=tests.length-1;index>0;index--) {
  seed=(Math.imul(seed,1664525)+1013904223)>>>0;
  const other=seed%(index+1);[tests[index],tests[other]]=[tests[other],tests[index]];
}
writeFileSync('test-artifacts/suite-order.json',JSON.stringify({seed:14102026,files:tests},null,2)+'\n');
const environment={...buildIsolatedTestEnvironment(process.env,{databaseUrl:process.env.DATABASE_URL}),DELIVERY_UI_COVERAGE:'1'};
const originalWrite=process.stdout.write.bind(process.stdout),chunks=[];
process.stdout.write=(chunk,...args)=>{chunks.push(String(chunk));return originalWrite(chunk,...args);};
let status;
try {status=await runNodeTestFilesIsolated(tests,{environment,label:'Quotation/full delivery regression'});}
finally {process.stdout.write=originalWrite;writeFileSync('test-artifacts/regressions.log',chunks.join(''));}
assert.equal(status,0,'Full scoped regression suite failed.');
run('baseline-restlet',process.execPath,['tools/delivery-estb-quote-baseline.mjs']);
run('restlet-harness',process.execPath,['src/netsuite-restlet-harness.js']);
run('mutations',process.execPath,['tools/delivery-estb-quote-mutations.mjs'],{...process.env,NODE_V8_COVERAGE:'',DELIVERY_UI_COVERAGE:'0'});
const sourceFiles=[...measured,'public/delivery-requests.js','src/netsuite-restlet-harness.js',...tests,...lintFiles.filter(file=>file.startsWith('tools/'))];
const changedFiles=[...measured,'src/netsuite-restlet-harness.js',...lintFiles,'tools/delivery-estb-quote-test.sh',
  'tools/delivery-estb-quote-package.py','docs/netsuite-quotation-pdf-upload.md','test/delivery-estb-quote-20261014-spec.md'];
run('secrets',process.execPath,['test/support/scan-diff-secrets.mjs',...new Set(changedFiles)]);
const hashes=Object.fromEntries([...new Set([...sourceFiles,...changedFiles])].map(file=>[file,createHash('sha256').update(readFileSync(file)).digest('hex')]));
const versions=Object.fromEntries(['typescript','eslint','c8','fast-check','@playwright/test','express','pg'].map(name=>[name,JSON.parse(readFileSync(`node_modules/${name}/package.json`)).version]));
const counts=[...chunks.join('').matchAll(/^ℹ tests (\d+)$/gmu)].map(match=>Number(match[1]));
writeFileSync('test-artifacts/summary.json',JSON.stringify({passed:counts.reduce((sum,count)=>sum+count,0),testFiles:tests.length,
  layers:stages,mutations:JSON.parse(readFileSync('test-artifacts/mutations/results.json')),
  versions:{node:process.version,...versions},sourceHashes:hashes,
  sourceHash:createHash('sha256').update(JSON.stringify(hashes)).digest('hex')},null,2)+'\n');
