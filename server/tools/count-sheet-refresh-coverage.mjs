import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import v8ToIstanbul from 'v8-to-istanbul';
import coverage from 'istanbul-lib-coverage';

const folder='test-artifacts/count-sheet-refresh';
const map=coverage.createCoverageMap(JSON.parse(readFileSync(`${folder}/coverage/coverage-final.json`)));
for(const entry of JSON.parse(readFileSync(`${folder}/browser-coverage.json`))) {
  const name=entry.url.split('/').at(-1);
  if(!['operator-inventory.js','control-count-sheets.js','control.js','operator.js'].includes(name)) {continue;}
  const converter=v8ToIstanbul('/app/public/'+name,0,{source:entry.source});await converter.load();
  converter.applyCoverage(entry.functions);
  map.merge(converter.toIstanbul());
}
const results=[];
const changedMap=JSON.parse(readFileSync('test/support/count-sheet-refresh-changed-lines.json'));
for(const file of ['src/count-sheet-stock-refresh.js','src/operator-inventory-router.js','src/count-sheet-repository.js',
  'src/inventory-packed-stock.js','src/cycle-count-stock-refresh.js','src/count-sheet-reconstruction.js',
  'src/inventory-repository.js','src/history-repository.js','src/server.js',
  'public/operator-inventory.js','public/control-count-sheets.js','public/control.js','public/operator.js']) {
  const current=readFileSync(file,'utf8').split('\n'),changed=changedMap[file].lines;
  const lines=map.fileCoverageFor('/app/'+file).getLineCoverage();
  const executable=changed.filter(line=>lines[line]!==undefined && current[line-1]?.trim() && !/^\s*(?:\/\/|[{}();,]+\s*$)/.test(current[line-1]));
  const missed=executable.filter(line=>!lines[line]);
  results.push({file,executable:executable.length,covered:executable.length-missed.length,missed});
}
const result={files:results,covered:results.reduce((n,r)=>n+r.covered,0),executable:results.reduce((n,r)=>n+r.executable,0)};
writeFileSync(`${folder}/merged-coverage.json`,JSON.stringify(map.toJSON()));
writeFileSync(`${folder}/changed-coverage.json`,JSON.stringify(result,null,2));console.log(JSON.stringify(result));
assert.ok(results.every(row=>row.missed.length===0),'Uncovered changed lines');
