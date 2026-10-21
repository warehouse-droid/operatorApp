import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {writeFileSync,readFileSync,mkdirSync,readdirSync,rmSync} from 'node:fs';
import {createHash} from 'node:crypto';
assert.equal(process.env.MBT_TEST_ISOLATED,'1');
const stages=[];
function run(name,args,extraEnv={}) {
  const result=spawnSync(process.execPath,args,{encoding:'utf8',timeout:300000,maxBuffer:12*1024*1024,env:{...process.env,...extraEnv}});
  writeFileSync(`test-artifacts/${name}.log`,result.stdout+result.stderr);
  stages.push({name,exitCode:result.status});writeFileSync('test-artifacts/stages.json',JSON.stringify(stages,null,2)+'\n');
  process.stdout.write(`${name}: ${result.status}\n`);
  if(result.status!==0) {process.stdout.write((result.stdout+result.stderr).slice(-5500));process.exit(result.status || 1);}
}
run('versions',['tools/delivery-request-quality.mjs','versions']);
run('types',['node_modules/.bin/tsc','--project','tools/tsconfig.special-po-sales.json']);
const runtime=['public/special-stock-po-reference.js','src/special-po-reference-alerts.js','public/special-po-reference-alert.js','public/sales-special-alert.js'];
run('lint',['node_modules/.bin/eslint','--config','tools/stock-request-layout-eslint.config.mjs','--max-warnings=0',...runtime,
  'test/mbt/unit/special-po-reference.test.js','test/mbt/integration/special-po-reference-http.test.js','test/mbt/integration/special-po-reference-browser.test.js',
  'tools/special-po-sales-checks.mjs','tools/special-po-sales-tests.mjs','tools/special-po-sales-mutations.mjs']);
for(const file of runtime) {run(`syntax-${file.split('/').at(-1)}`,['--check',file]);}
run('mutations',['tools/special-po-sales-mutations.mjs']);
mkdirSync('test-artifacts/delivery-requests-ui',{recursive:true});
for(const name of readdirSync('test-artifacts/delivery-requests-ui')) {rmSync(`test-artifacts/delivery-requests-ui/${name}`,{recursive:true,force:true});}
run('tests',['node_modules/.bin/c8','--all','--include=src/special-po-reference-alerts.js','--include=public/special-stock-po-reference.js',
  '--check-coverage=false','--report-dir=test-artifacts/coverage','--temp-directory=test-artifacts/v8','--reporter=json',process.execPath,'tools/special-po-sales-tests.mjs'],
  {SPECIAL_PO_REFERENCE_BROWSER_OUTPUT:'test-artifacts/delivery-requests-ui',SPECIAL_SALES_ALERT_BROWSER_OUTPUT:'test-artifacts/sales-alert-browser'});
// The shared coverage reporter accepts Chromium arrays named browser-coverage-*.
for(const name of readdirSync('test-artifacts/delivery-requests-ui').filter(name=>name.startsWith('coverage-'))) {
  writeFileSync(`test-artifacts/delivery-requests-ui/browser-${name}`,readFileSync(`test-artifacts/delivery-requests-ui/${name}`));
}
run('coverage',['tools/delivery-linkage-coverage.mjs']);
writeFileSync('test-artifacts/source-hashes.json',JSON.stringify(Object.fromEntries(runtime.map(file=>[file,createHash('sha256').update(readFileSync(file)).digest('hex')])),null,2)+'\n');
