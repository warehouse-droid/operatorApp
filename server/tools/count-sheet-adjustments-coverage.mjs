import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import v8ToIstanbul from 'v8-to-istanbul';
import coverage from 'istanbul-lib-coverage';
const out='test-artifacts/count-adjustments';
const map=coverage.createCoverageMap(JSON.parse(readFileSync(`${out}/coverage/coverage-final.json`)));
for (const file of ['count-sheet-adjustments-browser','inventory-count-review-browser','operator-inventory-browser']) {
  for (const entry of JSON.parse(readFileSync(`test-artifacts/${file}-coverage.json`))) {
    if (!entry.url.endsWith('/control-count-sheets.js')) {continue;}
    const converter=v8ToIstanbul('/app/public/control-count-sheets.js',0,{source:entry.source});
    await converter.load(); converter.applyCoverage(entry.functions); map.merge(converter.toIstanbul());
  }
}
const changed=JSON.parse(readFileSync('test-artifacts/changed-lines.json'));
const rows=[];
for (const [file,added] of Object.entries(changed)) {
  const lines=map.fileCoverageFor('/app/'+file).getLineCoverage();
  const code=readFileSync(file,'utf8').split('\n');
  const executable=added.filter(line=>lines[line]!==undefined && code[line-1]?.trim() && !/^\s*(?:\/\/|[{}();,]+\s*$)/.test(code[line-1]));
  const missed=executable.filter(line=>!lines[line]);
  rows.push({file,covered:executable.length-missed.length,total:executable.length,missed});
}
writeFileSync(`${out}/changed-coverage.json`,JSON.stringify(rows,null,2));
console.log(JSON.stringify(rows));
assert.ok(rows.every(row=>!row.missed.length),'Unexecuted changed lines');
