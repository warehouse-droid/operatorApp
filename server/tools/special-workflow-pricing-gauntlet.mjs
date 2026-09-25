import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
if (process.env.MBT_TEST_ISOLATED!=='1' || !process.env.DATABASE_URL?.endsWith('/mbt_verify')) throw new Error('Use the isolated verification database');
const output=process.env.SPECIAL_WORKFLOW_OUTPUT || 'test-artifacts/special-workflow-pricing/final';
rmSync(output,{recursive:true,force:true}); mkdirSync(output,{recursive:true});
const tests=[
 'test/mbt/unit/special-stock-request-domain.red.test.js','test/mbt/unit/special-stock-request-netsuite.red.test.js','test/mbt/unit/special-stock-request-policy.red.test.js','test/mbt/unit/special-stock-request-service.red.test.js','test/mbt/unit/special-stock-request-schema.red.test.js','test/mbt/unit/special-stock-request-wiring.red.test.js','test/mbt/property/special-stock-request-domain.property.test.js',
 'test/mbt/unit/special-workflow-review.test.js','test/mbt/unit/special-workflow-order-sync.test.js','test/mbt/unit/special-workflow-adapter.test.js','test/mbt/unit/special-workflow-deploy-readiness.test.js',
 'test/mbt/unit/special-workflow-polish.test.js','test/mbt/integration/special-workflow-polish.test.js','test/mbt/integration/special-workflow-polish-http.test.js','test/mbt/unit/feature-gate-catalog.test.js','test/mbt/integration/feature-gate-admin-http.test.js',
 'test/mbt/integration/special-workflow-review.test.js','test/mbt/integration/special-stock-request-workflow.red.test.js','test/mbt/integration/special-stock-request-http.red.test.js','test/mbt/integration/special-stock-request-dispatch-guard.red.test.js','test/dispatch/unit/dispatch-special-order-pallets.red.test.js'
];
tests.push('test/mbt/unit/special-workflow-pricing.test.js','test/mbt/unit/special-workflow-quantity-adapter.test.js','test/mbt/unit/special-workflow-quantity-service.test.js','test/mbt/integration/special-workflow-pricing.test.js','test/mbt/integration/special-workflow-pricing-http.test.js');
const files=['src/special-stock-request-domain.js','src/special-stock-request-policy.js','src/special-stock-request-netsuite.js','src/special-stock-request-service.js','src/special-stock-request-repository.js','src/special-stock-netsuite-adapter.js','src/dispatch-special-order-pallets.js','public/special-stock-workflow.js','public/sales-special-stock-requests.js','public/scm-special-stock-requests.js','public/dispatch-special-stock.js'];
files.push('public/special-stock-pricing.js','public/special-stock-calendar.js','src/special-stock-pricing-domain.js','src/special-stock-quantity-adapter.js','src/special-stock-quantity-service.js');
files.push('public/special-stock-form-state.js','src/mbt/feature-gate-catalog.js');
function run(name,command,args){
 const result=spawnSync(command,args,{encoding:'utf8',timeout:300000,maxBuffer:20*1024*1024,env:{...process.env,PLAYWRIGHT_BROWSERS_PATH:process.env.PLAYWRIGHT_BROWSERS_PATH||'/browsers'}});
 writeFileSync(`${output}/${name}.txt`,result.stdout+result.stderr);
 if(result.status!==0) throw new Error(`${name} failed; see ${output}/${name}.txt`);
 console.log(`PASS ${name}`);
}
run('tests-coverage','node_modules/.bin/c8',['--all=false','--check-coverage=false',...['src/special-stock-request-*.js','src/special-stock-pricing-domain.js','src/special-stock-quantity-*.js','public/special-stock-pricing.js','public/special-stock-calendar.js','src/special-stock-netsuite-adapter.js','public/special-stock-workflow.js','src/dispatch-special-order-pallets.js'].map(file=>`--include=${file}`),`--temp-directory=${output}/c8`,`--report-dir=${output}/coverage`,'--reporter=text','--reporter=json-summary','--reporter=json',process.execPath,'--test','--test-concurrency=1',...tests]);
run('changed-line-coverage',process.execPath,['tools/special-workflow-pricing-evidence.mjs']);
run('pure-coverage-gate','node_modules/.bin/c8',['report','--all=false','--check-coverage=true','--include=src/special-stock-request-domain.js','--include=src/special-stock-request-policy.js','--include=src/special-stock-request-netsuite.js','--include=src/special-stock-netsuite-adapter.js','--include=public/special-stock-workflow.js',`--temp-directory=${output}/c8`,`--report-dir=${output}/pure-coverage`,'--reporter=text','--reporter=json-summary','--lines=95','--functions=95','--statements=95','--branches=90']);
let shuffleState=24092026;
const shuffled=[...tests];
for(let i=shuffled.length-1;i>0;i--){shuffleState=(Math.imul(shuffleState,1664525)+1013904223)>>>0;const j=shuffleState%(i+1);[shuffled[i],shuffled[j]]=[shuffled[j],shuffled[i]];}
writeFileSync(`${output}/suite-order.json`,JSON.stringify({seed:24092026,files:shuffled},null,2));
run('suite-health',process.execPath,['tools/special-workflow-suite-health.mjs',...shuffled]);
run('types','node_modules/.bin/tsc',['--noEmit','--allowJs','--checkJs','--skipLibCheck','--target','ES2022','--module','NodeNext','public/special-stock-pricing.js','public/special-stock-calendar.js','src/special-stock-quantity-adapter.js','public/special-stock-workflow.js','public/special-stock-form-state.js','src/special-stock-netsuite-adapter.js']);
run('lint','node_modules/.bin/eslint',['--config','tools/special-workflow-eslint.config.mjs','--max-warnings=0',...files]);
for(const file of ['src/server.js','src/netsuite.js','src/dispatch-plan-repository.js','src/dispatch-repository.js','public/dispatch.js'])run(`syntax-${file.replaceAll('/','-')}`,process.execPath,['--check',file]);
run('mutations',process.execPath,['tools/special-workflow-mutations.mjs']);
run('pricing-mutations',process.execPath,['tools/special-workflow-pricing-mutations.mjs']);
run('polish-mutations',process.execPath,['tools/special-workflow-polish-mutations.mjs']);
run('pricing-browser',process.execPath,['tools/special-workflow-pricing-browser.mjs']);
run('browser',process.execPath,['tools/special-workflow-browser-verify.mjs']);
run('polish-browser',process.execPath,['tools/special-workflow-polish-browser.mjs']);
run('pricing-frontend-flow',process.execPath,['tools/special-workflow-pricing-flow.mjs']);
run('frontend-flow',process.execPath,['tools/special-workflow-polish-flow.mjs']);
const allFiles=[...files,...tests,'migrations/225_special_workflow_review.sql','src/server.js','src/netsuite.js','src/dispatch-plan-repository.js','src/dispatch-repository.js','public/dispatch.js','public/stock-requests.css','public/sales-stock-requests.html','public/scm-stock-requests.html','public/dispatch-special-stock.html','tools/special-workflow-gauntlet.mjs','tools/special-workflow-mutations.mjs','tools/special-workflow-browser.mjs','tools/special-workflow-browser-verify.mjs','tools/special-workflow-review-app.mjs','tools/special-workflow-review-proxy.mjs','tools/special-workflow-cleanup.py','tools/special-workflow-secret-scan.mjs','tools/special-workflow-eslint.config.mjs','tools/special-workflow-check.sh','test/special-workflow-cleanup.test.py','test/special-workflow-review-spec.md','test/support/scan-diff-secrets.mjs','package.json','package-lock.json'];
allFiles.push('tools/special-workflow-suite-health.mjs');
allFiles.push('migrations/226_special_workflow_test_skips.sql','tools/special-workflow-polish-migrate.mjs','tools/special-workflow-polish-browser.mjs','tools/special-workflow-polish-mutations.mjs','test/special-workflow-polish-spec.md','tools/special-workflow-polish-check.sh');
allFiles.push('tools/special-workflow-polish-flow.mjs','tools/special-workflow-pricing-gauntlet.mjs','tools/special-workflow-pricing-browser.mjs','tools/special-workflow-pricing-migrate.mjs','tools/special-workflow-pricing-flow.mjs','tools/special-workflow-pricing-mutations.mjs','migrations/228_special_workflow_pricing.sql','test/special-workflow-pricing-spec.md','tools/special-workflow-pricing-check.sh','tools/special-workflow-pricing-evidence.mjs','test/special-workflow-pricing-changed-lines.json');
run('secrets',process.execPath,['tools/special-workflow-secret-scan.mjs',...allFiles]);
writeFileSync(`${output}/source-manifest.json`,JSON.stringify(Object.fromEntries(allFiles.map(file=>[file,createHash('sha256').update(readFileSync(file)).digest('hex')])),null,2));
writeFileSync(`${output}/versions.json`,JSON.stringify({node:process.version,...Object.fromEntries(['pg','c8','eslint','typescript','playwright','fast-check'].map(name=>[name,JSON.parse(readFileSync(`node_modules/${name}/package.json`)).version]))},null,2));
console.log('Special workflow gauntlet completed, including retained frontend examples.');
