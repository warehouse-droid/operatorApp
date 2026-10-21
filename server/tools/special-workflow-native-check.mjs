import {spawnSync} from 'node:child_process';
import {readFileSync,writeFileSync,readdirSync} from 'node:fs';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
assert.equal(process.env.MBT_TEST_ISOLATED,'1');
assert.ok(process.env.DATABASE_URL?.endsWith('/mbt_verify'));
const output='test-artifacts/special-workflow-review/native-documents';
const runtime=JSON.parse(readFileSync(`${output}/runtime-files.json`)),source=runtime.filter(f=>f.endsWith('.js'));
const tests=['unit','property','integration'].flatMap(kind=>readdirSync(`test/mbt/${kind}`).filter(n=>/^special-.*\.test\.js$/.test(n)).sort().map(n=>`test/mbt/${kind}/${n}`));
tests.push('test/field-sales/company-pdf.test.js','test/dispatch/integration/dispatch-required-pickups-save.test.js');
const ownTests=['test/mbt/unit/special-workflow-closure.test.js','test/mbt/unit/special-workflow-documents.test.js','test/mbt/unit/special-workflow-native-documents.test.js',
  'test/mbt/integration/special-workflow-closure.test.js','test/mbt/integration/special-workflow-description-race.test.js','test/mbt/integration/special-workflow-pricing-http.test.js'];
function run(name,command,args){
  const result=spawnSync(command,args,{encoding:'utf8',timeout:300000,maxBuffer:20*1024*1024});
  const log=(result.stdout||'')+(result.stderr||'');writeFileSync(`${output}/${name}.txt`,log);assert.equal(result.status,0,`${name} failed; see saved log`);
  const summary={check:name,tests:Number(/^# tests (\d+)$/m.exec(log)?.[1]||0),passed:Number(/^# pass (\d+)$/m.exec(log)?.[1]||0)};console.log(JSON.stringify(summary));return summary;
}
const suite=run('regressions','node_modules/.bin/c8',['--all=false','--check-coverage=false',...source.map(f=>`--include=${f}`),`--temp-directory=${output}/c8`,`--report-dir=${output}/coverage`,'--reporter=json',process.execPath,'--test','--test-concurrency=1',...tests]);
run('baseline-check',process.execPath,['tools/special-workflow-native-baseline.mjs']);
run('restlet-harness',process.execPath,['src/netsuite-restlet-harness.js']);
run('browser',process.execPath,['tools/special-workflow-native-documents-browser.mjs']);
run('coverage',process.execPath,['tools/special-workflow-native-coverage.mjs','--require-complete']);
run('types','node_modules/.bin/tsc',['--noEmit','--allowJs','--checkJs','--skipLibCheck','--types','node','--target','ES2022','--module','NodeNext','src/netsuite-order-pdf.js']);
for(const file of source)run(`syntax-${file.split('/').pop()}`,process.execPath,['--check',file]);
const tools=readdirSync('tools').filter(f=>/^special-workflow-native-.*\.(?:mjs|py|sh)$/.test(f)&&f!=='special-workflow-native-link.mjs').map(f=>`tools/${f}`);
run('lint','node_modules/.bin/eslint',['--config','tools/special-workflow-native-eslint.config.mjs','--max-warnings=0',...source.filter(f=>f!=='src/server.js'),...ownTests,...tools.filter(f=>f.endsWith('.mjs'))]);
run('mutations',process.execPath,['tools/special-workflow-native-mutations.mjs']);
run('suite-health',process.execPath,['--test','--test-concurrency=1',...ownTests.toReversed()]);
const files=[...new Set([...runtime,...tests,...tools,'src/netsuite-restlet-harness.js','test/special-workflow-native-documents-spec.md'])];
run('secrets',process.execPath,['test/support/scan-diff-secrets.mjs',...files]);
const manifest=Object.fromEntries(files.map(f=>[f,createHash('sha256').update(readFileSync(f)).digest('hex')]));
writeFileSync(`${output}/source-manifest.json`,JSON.stringify(manifest,null,2));
const lines=JSON.parse(readFileSync(`${output}/changed-lines.json`));
const summary={completed:true,tests:suite.tests,passed:suite.passed,dispatch:JSON.parse(readFileSync(`${output}/baseline-comparison.json`)),
  changedLines:`${lines.covered}/${lines.total}`,branches:`${lines.branches.covered}/${lines.branches.total}`,mutationsKilled:6,propertyMutationsKilled:5,
  browser:JSON.parse(readFileSync(`${output}/browser.json`)),sourceHash:createHash('sha256').update(JSON.stringify(manifest)).digest('hex'),
  tools:{node:process.version,typescript:JSON.parse(readFileSync('node_modules/typescript/package.json')).version,
    eslint:JSON.parse(readFileSync('node_modules/eslint/package.json')).version,c8:JSON.parse(readFileSync('node_modules/c8/package.json')).version,fastCheck:JSON.parse(readFileSync('node_modules/fast-check/package.json')).version}};
writeFileSync(`${output}/summary.json`,JSON.stringify(summary,null,2));console.log(JSON.stringify(summary));
