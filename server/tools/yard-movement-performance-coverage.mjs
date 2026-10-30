import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import v8ToIstanbul from 'v8-to-istanbul';
import coverage from 'istanbul-lib-coverage';
const out='test-artifacts/yard-performance';
const map=coverage.createCoverageMap(JSON.parse(readFileSync(`${out}/coverage/coverage-final.json`)));
for(const entry of JSON.parse(readFileSync('test-artifacts/yard-performance-browser-coverage.json'))){
  const file=new URL(entry.url).pathname;
  if(!['/control.js','/dispatch-loaded-export.js','/yard-movement-requests.js'].includes(file)) continue;
  const converter=v8ToIstanbul('/app/public'+file,0,{source:entry.source});
  await converter.load();converter.applyCoverage(entry.functions);map.merge(converter.toIstanbul());
}
const changed=JSON.parse(readFileSync('test-artifacts/changed-lines.json')),rows=[];
for(const [file,added] of Object.entries(changed)){
  const lines=map.fileCoverageFor('/app/'+file).getLineCoverage(),code=readFileSync(file,'utf8').split('\n');
  const executable=added.filter(line=>lines[line]!==undefined&&code[line-1]?.trim()&&!/^\s*(?:\/\/|[{}();,]+\s*$)/.test(code[line-1]));
  const missed=executable.filter(line=>!lines[line]);rows.push({file,covered:executable.length-missed.length,total:executable.length,missed});
}
writeFileSync(`${out}/changed-coverage.json`,JSON.stringify(rows,null,2));console.log(JSON.stringify(rows));
assert.ok(rows.every(row=>!row.missed.length),'Unexecuted changed lines');
