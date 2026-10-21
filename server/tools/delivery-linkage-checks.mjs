import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {writeFileSync,readFileSync,readdirSync,rmSync} from 'node:fs';
import {createHash} from 'node:crypto';
assert.equal(process.env.MBT_TEST_ISOLATED,'1');
const stages=[];
function run(name,args,extraEnv={}) {
  const result=spawnSync(process.execPath,args,{encoding:'utf8',timeout:360000,env:{...process.env,...extraEnv},maxBuffer:12*1024*1024});
  writeFileSync(`test-artifacts/${name}.log`,result.stdout+result.stderr);
  stages.push({name,exitCode:result.status});writeFileSync('test-artifacts/stages.json',JSON.stringify(stages,null,2)+'\n');
  process.stdout.write(`${name}: ${result.status}\n`);
  if(result.status!==0) {process.stdout.write((result.stdout+result.stderr).slice(-4500));process.exit(result.status || 1);}
}
run('versions',['tools/delivery-request-quality.mjs','versions']);
run('types',['tools/delivery-request-quality.mjs','types']);
run('lint',['tools/delivery-request-static.mjs']);
run('tool-lint',['node_modules/.bin/eslint','--config','tools/delivery-request-eslint.config.mjs','--max-warnings=0','tools/delivery-linkage-*.mjs']);
for(const file of ['public/dispatch.js','public/app-sidebar.js','src/dispatch-order-catalog-repository.js','src/dispatch-planner-optimization.js']) {run(`syntax-${file.split('/').at(-1)}`,['--check',file]);}
run('mutations',['tools/delivery-linkage-mutations.mjs']);
for(const name of readdirSync('test-artifacts/delivery-requests-ui').filter(file=>file.startsWith('browser-coverage-'))) {rmSync(`test-artifacts/delivery-requests-ui/${name}`);}
run('tests',['node_modules/.bin/c8','--all','--include=src/delivery-request*.js','--include=src/dispatch-order-catalog-repository.js',
  '--include=src/dispatch-planner-optimization.js','--include=public/dispatch.js','--exclude=test/**','--check-coverage=false',
  '--report-dir=test-artifacts/coverage','--temp-directory=test-artifacts/v8','--reporter=json','--reporter=text',
  process.execPath,'tools/delivery-linkage-tests.mjs'],{DELIVERY_UI_COVERAGE:'1'});
run('coverage',['tools/delivery-linkage-coverage.mjs']);
const diffs=JSON.parse(readFileSync('test-artifacts/changed-lines-input.json'));
const sources=Object.fromEntries(Object.keys(diffs).map(file=>[file,createHash('sha256').update(readFileSync(file)).digest('hex')]));
writeFileSync('test-artifacts/source-hashes.json',JSON.stringify(sources,null,2)+'\n');
