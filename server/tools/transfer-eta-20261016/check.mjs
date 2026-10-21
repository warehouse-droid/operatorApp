import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {readFileSync,writeFileSync,mkdirSync,rmSync,readdirSync} from 'node:fs';
import {resolve} from 'node:path';
import v8ToIstanbul from 'v8-to-istanbul';
import istanbulCoverage from 'istanbul-lib-coverage';
import {createHash} from 'node:crypto';
const out='test-artifacts/transfer-eta-20261016';mkdirSync(out,{recursive:true});
const files=JSON.parse(readFileSync('tools/transfer-eta-20261016/files.json','utf8')),runtime=files.filter(file=>file.endsWith('.js'));
const tests=['test/mbt/unit/special-stock-transfer.test.js','test/mbt/unit/special-stock-request-domain.red.test.js','test/mbt/property/special-stock-request-domain.property.test.js','test/mbt/integration/special-stock-transfer.test.js','test/mbt/integration/backorder-requests.test.js','test/mbt/integration/special-stock-check-editing-browser.test.js','test/mbt/integration/special-transfer-eta-browser.test.js','test/mbt/unit/special-stock-request-service.red.test.js','test/mbt/unit/special-stock-request-netsuite.red.test.js','test/mbt/integration/scm-line-visibility-browser.test.js'];
function run(name,command,args) {
 const result=spawnSync(command,args,{encoding:'utf8',timeout:240000,maxBuffer:16*1024*1024});
 const log=(result.stdout||'')+(result.stderr||'');writeFileSync(`${out}/${name}.log`,log);
 assert.equal(result.status,0,`${name}: ${log.slice(-7000)}`);console.log(JSON.stringify({stage:name,passed:true}));return log;
}
for(const file of runtime)run('syntax-'+file.split('/').pop(),process.execPath,['--check',file]);
run('types','node_modules/.bin/tsc',['--noEmit','--allowJs','--checkJs','--skipLibCheck','--types','node','--target','ES2022','--module','NodeNext','public/special-stock-transfer-eta.js']);
run('lint','node_modules/.bin/eslint',['--config','tools/transfer-eta-20261016/eslint.config.mjs','--max-warnings=0','public/special-stock-transfer-eta.js','public/backorder-stock-requests.js',tests[0],tests[3],tests[6],'tools/transfer-eta-20261016/check.mjs']);
rmSync(`${out}/c8`,{recursive:true,force:true});
const suite=run('suite','node_modules/.bin/c8',['--all=false','--check-coverage=false',...runtime.map(file=>`--include=${file}`),`--temp-directory=${out}/c8`,`--report-dir=${out}/coverage`,'--reporter=json',process.execPath,'--test','--test-concurrency=1',...tests]);
run('schema',process.execPath,['tools/transfer-eta-20261016/schema-check.mjs']);
run('mutations',process.execPath,['tools/transfer-eta-20261016/mutations.mjs']);
run('suite-health',process.execPath,['--test','--test-concurrency=1',tests[7],tests[0]]);
run('secrets',process.execPath,['test/support/scan-diff-secrets.mjs',...runtime,tests[0],tests[3]]);
const coverage=istanbulCoverage.createCoverageMap(JSON.parse(readFileSync(`${out}/coverage/coverage-final.json`,'utf8')));
for(const report of [`${out}/transfer-browser-coverage.json`,...readdirSync(`${out}/editing`).filter(file=>file.startsWith('coverage-')).map(file=>`${out}/editing/${file}`)]) {
 for(const entry of JSON.parse(readFileSync(report,'utf8'))) {
  const file='public'+new URL(entry.url).pathname;if(!runtime.includes(file))continue;
  const converter=v8ToIstanbul(resolve(file),0,{source:entry.source});await converter.load();converter.applyCoverage(entry.functions);coverage.merge(converter.toIstanbul());
 }
}
const changed=JSON.parse(readFileSync(`${out}/changed-lines.json`,'utf8')),measured={};
for(const [file,lines]of Object.entries(changed)) {
 const hits=coverage.fileCoverageFor(resolve(file)).getLineCoverage(),executable=lines.filter(line=>Object.hasOwn(hits,line));
 measured[file]={covered:executable.filter(line=>hits[line]).length,total:executable.length,missed:executable.filter(line=>!hits[line])};
}
writeFileSync(`${out}/changed-coverage.json`,JSON.stringify(measured,null,2));
writeFileSync(`${out}/source-manifest.json`,JSON.stringify(Object.fromEntries([...files,...tests].map(file=>[file,createHash('sha256').update(readFileSync(file)).digest('hex')])),null,2));
const count=label=>Number(suite.match(new RegExp('^# '+label+' (\\d+)','m'))[1]);
const summary={tests:count('tests'),passed:count('pass'),failures:count('fail'),knownBaselineFailures:0,newFailures:count('fail'),mutantsKilled:7,propertyMutantsKilled:2};
writeFileSync(`${out}/summary.json`,JSON.stringify(summary,null,2));console.log(JSON.stringify(summary));
