import {spawnSync} from 'node:child_process';
import {readFileSync,writeFileSync,readdirSync} from 'node:fs';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
assert.equal(process.env.MBT_TEST_ISOLATED,'1');
assert.ok(process.env.DATABASE_URL?.endsWith('/mbt_verify'));
const out='test-artifacts/special-workflow-review/adjustments';
const runtime=JSON.parse(readFileSync(`${out}/runtime-files.json`)),source=runtime.filter(f=>f.endsWith('.js'));
const tests=['unit','property','integration'].flatMap(kind=>readdirSync(`test/mbt/${kind}`).filter(n=>/^special-.*\.test\.js$/.test(n)).sort().map(n=>`test/mbt/${kind}/${n}`));
const own=tests.filter(f=>/adjustment|special-stock-request-service|special-workflow-(?:pricing|documents|description-race)/.test(f));
const tools=readdirSync('tools').filter(f=>/^special-workflow-adjustments-.*\.(?:mjs|py|sh)$/.test(f)).map(f=>`tools/${f}`);
function run(name,cmd,args){
 const r=spawnSync(cmd,args,{encoding:'utf8',timeout:300000,maxBuffer:20*1024*1024});
 const log=(r.stdout||'')+(r.stderr||'');writeFileSync(`${out}/${name}.txt`,log);
 assert.equal(r.status,0,`${name} failed; see ${out}/${name}.txt`);
 console.log(JSON.stringify({check:name,passed:true}));return log;
}
const suite=run('related-tests','node_modules/.bin/c8',['--all=false','--check-coverage=false',...source.map(f=>`--include=${f}`),`--temp-directory=${out}/c8`,`--report-dir=${out}/coverage`,'--reporter=json',process.execPath,'--test','--test-concurrency=1',...tests]);
run('restlet-harness',process.execPath,['src/netsuite-restlet-harness.js']);
run('sales-browser',process.execPath,['tools/special-workflow-adjustments-browser.mjs']);
run('scm-browser',process.execPath,['tools/special-workflow-adjustments-scm-browser.mjs']);
run('coverage',process.execPath,['tools/special-workflow-adjustments-coverage.mjs']);
run('types','node_modules/.bin/tsc',['--noEmit','--allowJs','--checkJs','--skipLibCheck','--types','node','--target','ES2022','--module','NodeNext','public/special-stock-pricing.js','src/special-stock-adjustment-adapter.js']);
for(const file of source)run(`syntax-${file.split('/').pop()}`,process.execPath,['--check',file]);
run('lint','node_modules/.bin/eslint',['--config','tools/special-workflow-native-eslint.config.mjs','--max-warnings=0',...source,...own,...tools.filter(f=>f.endsWith('.mjs'))]);
run('mutations',process.execPath,['tools/special-workflow-adjustments-mutations.mjs']);
run('suite-health',process.execPath,['--test','--test-concurrency=1',...own.toReversed()]);
run('secrets',process.execPath,['test/support/scan-diff-secrets.mjs',...runtime,...own,...tools]);
const files=[...new Set([...runtime,...tests,...tools,'src/netsuite-restlet-harness.js','test/special-workflow-adjustments-spec.md'])];
const hashes=Object.fromEntries(files.map(f=>[f,createHash('sha256').update(readFileSync(f)).digest('hex')]));
writeFileSync(`${out}/source-manifest.json`,JSON.stringify(hashes,null,2));
const coverage=JSON.parse(readFileSync(`${out}/changed-lines.json`));
const summary={completed:true,tests:Number(/^# tests (\d+)$/m.exec(suite)?.[1]),passed:Number(/^# pass (\d+)$/m.exec(suite)?.[1]),
 sourceHash:createHash('sha256').update(JSON.stringify(hashes)).digest('hex'),coverage,mutations:5,propertyMutations:5,
 browser:[...JSON.parse(readFileSync(`${out}/browser.json`)),...JSON.parse(readFileSync(`${out}/scm-browser.json`))],
 tools:{node:process.version,...Object.fromEntries(['typescript','eslint','c8','fast-check'].map(name=>[name,JSON.parse(readFileSync(`node_modules/${name}/package.json`)).version]))}};
writeFileSync(`${out}/summary.json`,JSON.stringify(summary,null,2));console.log(JSON.stringify({completed:true,tests:summary.tests,passed:summary.passed,changedLines:`${coverage.covered}/${coverage.total}`}));
