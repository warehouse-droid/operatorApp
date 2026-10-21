import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {readFileSync,writeFileSync,readdirSync,mkdirSync} from 'node:fs';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import v8ToIstanbul from 'v8-to-istanbul';
import istanbulCoverage from 'istanbul-lib-coverage';
const out='test-artifacts/scm-line-visibility-20261016';mkdirSync(out,{recursive:true});
const files=JSON.parse(readFileSync('tools/scm-line-visibility-20261016/files.json','utf8')),runtime=files.filter(file=>file.endsWith('.js'));
const tests=['test/mbt/integration/scm-line-visibility-browser.test.js','test/mbt/integration/special-stock-check-editing-browser.test.js','test/mbt/integration/stock-request-conversation-browser.test.js','test/mbt/unit/special-line-decline.test.js','test/mbt/unit/backorder-workflow.test.js'];
function run(name,command,args) {
 const result=spawnSync(command,args,{encoding:'utf8',timeout:240000,maxBuffer:8*1024*1024});
 const log=(result.stdout||'')+(result.stderr||'');writeFileSync(`${out}/${name}.log`,log);
 assert.equal(result.status,0,`${name}: ${log.slice(-5000)}`);console.log(JSON.stringify({stage:name,passed:true}));return log;
}
for(const file of runtime)run('syntax-'+file.split('/').pop(),process.execPath,['--check',file]);
run('lint','node_modules/.bin/eslint',['--config','tools/special-workflow-native-eslint.config.mjs','--max-warnings=0','public/scm-request-line-visibility.js',tests[0],tests[1],'tools/scm-line-visibility-20261016/check.mjs']);
const suite=run('suite',process.execPath,['--test','--test-concurrency=1',...tests]);
run('secrets',process.execPath,['test/support/scan-diff-secrets.mjs',...runtime,tests[0]]);
const coverage=istanbulCoverage.createCoverageMap({});
const reports=[`${out}/visibility-browser-coverage.json`,`${out}/browser-coverage.json`,...readdirSync(`${out}/editing`).filter(file=>file.startsWith('coverage-')).map(file=>`${out}/editing/${file}`)];
for(const report of reports)for(const entry of JSON.parse(readFileSync(report,'utf8'))) {
 const file='public'+new URL(entry.url).pathname;if(!runtime.includes(file))continue;
 const converter=v8ToIstanbul(resolve(file),0,{source:entry.source});await converter.load();converter.applyCoverage(entry.functions);coverage.merge(converter.toIstanbul());
}
writeFileSync(`${out}/coverage.json`,JSON.stringify(coverage.toJSON()));
const changed=JSON.parse(readFileSync(`${out}/changed-lines.json`,'utf8')),measured={};
for(const [file,lines]of Object.entries(changed)) {
 const hits=coverage.fileCoverageFor(resolve(file)).getLineCoverage(),executable=lines.filter(line=>Object.hasOwn(hits,line));
 measured[file]={covered:executable.filter(line=>hits[line]).length,total:executable.length,missed:executable.filter(line=>!hits[line])};
}
writeFileSync(`${out}/changed-coverage.json`,JSON.stringify(measured,null,2));
const hashes=Object.fromEntries([...files,...tests,'tools/scm-line-visibility-20261016/check.mjs'].map(file=>[file,createHash('sha256').update(readFileSync(file)).digest('hex')]));
writeFileSync(`${out}/source-manifest.json`,JSON.stringify(hashes,null,2));
const count=label=>Number(suite.match(new RegExp('^# '+label+' (\\d+)','m'))[1]);
const summary={tests:count('tests'),passed:count('pass'),failures:count('fail'),knownBaselineFailures:0,newFailures:count('fail')};
writeFileSync(`${out}/summary.json`,JSON.stringify(summary,null,2));console.log(JSON.stringify(summary));
