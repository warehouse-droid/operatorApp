import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,readdirSync} from 'node:fs';
import {createHash} from 'node:crypto';
const folder=process.env.FIELD_SALES_ARTIFACT_DIR;
const json=file=>JSON.parse(readFileSync(`${folder}/${file}`,'utf8'));
const log=file=>readFileSync(`${folder}/${file}`,'utf8');
const runtime=JSON.parse(readFileSync('tools/field-sales-quote-memo-files.json','utf8'));
const files=[...new Set([...runtime,...['src/field-sales','public/field-sales','test/field-sales'].flatMap(dir=>readdirSync(dir).filter(n=>n.endsWith('.js')).map(n=>dir+'/'+n)),...readdirSync('tools').filter(n=>n.startsWith('field-sales-quote-memo-')).map(n=>'tools/'+n),'test/field-sales-quote-memo-spec.md','tools/field-sales-browser.mjs','tools/field-sales-trade-browser.mjs','tools/field-sales-recent-health.mjs'])].sort();
const hash=createHash('sha256'),source={};for(const file of files){const data=readFileSync(file);hash.update(file+'\0');hash.update(data);source[file]=createHash('sha256').update(data).digest('hex');}
const sourceSha256=hash.digest('hex');
if(process.argv[2]==='start'){
  writeFileSync(`${folder}/source-before.json`,JSON.stringify({source,sourceSha256},null,2));
}else{
  assert.deepEqual({source,sourceSha256},json('source-before.json'),'Source changed during verification');
  assert.match(log('coverage.log'),/# tests 94\b/);assert.match(log('coverage.log'),/# fail 0\b/);assert.match(log('coverage.log'),/# skipped 0\b/);
  for(const name of ['lint.log','types.log']){assert.equal(log(name).trim(),'');}
  const browsers={};for(const [name,count] of [['trade-browser-results.json',6],['browser-results.json',5]]){const report=json(name);assert.equal(report.passed,count);assert.deepEqual(report.errors,[]);browsers[name]=report;}
  const mutants=json('mutations.log');assert.equal(mutants.killed,4);assert.ok(mutants.results.every(r=>r.killed));
  const health=json('health.log');assert.equal(health.passed,true);
  const changedLines=json('changed-lines.json');assert.equal(changedLines.passed,true);assert.deepEqual(changedLines.unmeasured,[]);
  const report={passed:true,specApproval:'not obtained (autonomous run)',at:new Date().toISOString(),tests:94,browsers,mutants,health,changedLines,coverage:json('coverage/coverage-summary.json'),uiCoverage:json('ui-coverage/coverage-summary.json'),source,sourceSha256,runtimeFiles:runtime};
  writeFileSync(`${folder}/checks.json`,JSON.stringify(report,null,2));console.log(JSON.stringify({passed:true,tests:94,browserScenarios:11,mutants:4,changedLines,sourceSha256}));
}
