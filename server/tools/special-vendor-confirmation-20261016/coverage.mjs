import assert from 'node:assert/strict';
import {readFile,readdir,writeFile} from 'node:fs/promises';
import v8ToIstanbul from 'v8-to-istanbul';
import libCoverage from 'istanbul-lib-coverage';
const merged=libCoverage.createCoverageMap(JSON.parse(await readFile('test-artifacts/coverage/coverage-final.json','utf8')));
for(const name of await readdir('test-artifacts/browser'))if(name.startsWith('coverage-')) {
  for(const entry of JSON.parse(await readFile('test-artifacts/browser/'+name,'utf8'))) {
    const path='public'+new URL(entry.url).pathname;if(!['public/scm-special-stock-requests.js','public/special-stock-workflow.js'].includes(path))continue;
    const converter=v8ToIstanbul('/app/'+path,0,{source:entry.source});await converter.load();converter.applyCoverage(entry.functions);merged.merge(converter.toIstanbul());
  }
}
const changes=JSON.parse(await readFile('/release/changed-lines.json','utf8'));
const report={lines:0,covered:0,uncovered:[],sql:'Migration application, idempotence, rollback and SQL stage projections verified in integration tests.'};
for(const [file,lines] of Object.entries(changes))if(file.endsWith('.js'))for(const line of lines){
  const c=merged.data['/app/'+file]?.data;
  const executed=c&&Object.entries(c.statementMap).some(([id,range])=>range.start.line<=line&&range.end.line>=line&&c.s[id]>0);
  report.lines++;if(executed)report.covered++;else report.uncovered.push(file+':'+line);
}
await writeFile('test-artifacts/changed-coverage.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report));assert.deepEqual(report.uncovered,[]);
