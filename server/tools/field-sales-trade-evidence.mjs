import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,readdirSync} from 'node:fs';
import {createHash} from 'node:crypto';
const folder=process.env.FIELD_SALES_ARTIFACT_DIR||'test-artifacts/field-sales/trade';
const json=file=>JSON.parse(readFileSync(`${folder}/${file}`,'utf8'));
const log=file=>readFileSync(`${folder}/${file}`,'utf8');
for(const file of ['focused.log','coverage.log']){assert.match(log(file),/# tests 94\b/);assert.match(log(file),/# fail 0\b/);assert.match(log(file),/# skipped 0\b/);}
for(const file of ['lint.log','types.log','complexity.log']){assert.equal(log(file).trim(),'');}
const browsers={};for(const [name,count] of [['trade',6],['visiting',4],['recent',3],['map',7],['',5]]){const result=json(`${name?name+'-':''}browser-results.json`);assert.equal(result.passed,count);assert.deepEqual(result.errors,[]);browsers[name||'original']=result.passed;}
const mutants=json('mutations.log');assert.equal(mutants.killed,9);assert.ok(mutants.results.every(r=>r.killed));const health=json('health.log');assert.equal(health.passed,true);
const runtime=JSON.parse(readFileSync('tools/field-sales-trade-files.json','utf8'));
const files=[...new Set([...runtime,...readdirSync('test/field-sales').filter(n=>n.endsWith('.js')||n.endsWith('.md')).map(n=>'test/field-sales/'+n),...readdirSync('tools').filter(n=>n.startsWith('field-sales-trade-')).map(n=>'tools/'+n), 'tools/field-sales-browser.mjs','tools/field-sales-visiting-browser.mjs','tools/field-sales-recent-health.mjs'])].sort();
const hash=createHash('sha256'),source={};for(const file of files){const data=readFileSync(file);hash.update(file+'\0');hash.update(data);source[file]=createHash('sha256').update(data).digest('hex');}
const coverage=json('coverage/coverage-summary.json'),uiCoverage=json('ui-coverage/coverage-summary.json'),changedLines=json('changed-lines.json');
const report={passed:true,specApproval:'not obtained (autonomous run)',at:new Date().toISOString(),tests:94,browsers,mutants,health,coverage,uiCoverage,changedLines,source,sourceSha256:hash.digest('hex'),sourceFiles:files,runtimeFiles:runtime};
writeFileSync(`${folder}/checks.json`,JSON.stringify(report,null,2));console.log(JSON.stringify({passed:true,tests:94,browserScenarios:Object.values(browsers).reduce((a,b)=>a+b,0),mutants:mutants.killed,sourceSha256:report.sourceSha256}));
