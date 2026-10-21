import {readFileSync,writeFileSync,readdirSync} from 'node:fs';
import {resolve} from 'node:path';
import assert from 'node:assert/strict';
import coverage from 'istanbul-lib-coverage';
import v8ToIstanbul from 'v8-to-istanbul';
const output='test-artifacts/special-workflow-review/batch-discount-20260928';
const source=JSON.parse(readFileSync(`${output}/runtime-files.json`)).filter(f=>f.endsWith('.js'));
const measured=coverage.createCoverageMap(JSON.parse(readFileSync(`${output}/coverage/coverage-final.json`)));
for(const name of readdirSync(output).filter(n=>n.startsWith('browser-coverage-')&&n.endsWith('.json'))){
  for(const entry of JSON.parse(readFileSync(`${output}/${name}`))){
    const file=`public/${new URL(entry.url).pathname.split('/').pop()}`;if(!source.includes(file))continue;const sourceText=readFileSync(file,'utf8');assert.equal(entry.source,sourceText,'Browser source drift');
    const converter=v8ToIstanbul(resolve(file),0,{source:sourceText});await converter.load();converter.applyCoverage(entry.functions);measured.merge(converter.toIstanbul());
  }
}
const report={covered:0,total:0,uncovered:[],files:{},branches:{covered:0,total:0,uncovered:[]}};
let file;const changed=new Map();
for(const line of readFileSync(`${output}/runtime.diff`,'utf8').split('\n')){
  if(line.startsWith('+++ b/server/'))file=line.slice('+++ b/server/'.length);
  const hunk=/^@@ .* \+(\d+)(?:,(\d+))? @@/.exec(line);if(!hunk||!source.includes(file))continue;
  const numbers=changed.get(file)||new Set();changed.set(file,numbers);
  for(let n=Number(hunk[1]);n<Number(hunk[1])+Number(hunk[2]??1);n++)numbers.add(n);
}
for(const [file,numbers] of changed){
  assert.ok(measured.files().includes(resolve(file)),`Missing coverage: ${file}`);
  const entry=measured.fileCoverageFor(resolve(file)),lines=entry.getLineCoverage(),detail={covered:0,total:0};report.files[file]=detail;
  for(const n of numbers){if(!Object.hasOwn(lines,n))continue;report.total++;detail.total++;if(lines[n]){report.covered++;detail.covered++;}else report.uncovered.push(`${file}:${n}`);}
  for(const [key,branch] of Object.entries(entry.branchMap)){
    if(!numbers.has(branch.line))continue;
    for(const count of entry.b[key]){report.branches.total++;if(count)report.branches.covered++;else report.branches.uncovered.push(`${file}:${branch.line}`);}
  }
}
writeFileSync(`${output}/changed-lines.json`,JSON.stringify(report,null,2));console.log(JSON.stringify({covered:report.covered,total:report.total,branches:report.branches,uncovered:report.uncovered}));
if(process.argv.includes('--require-complete'))assert.deepEqual(report.uncovered,[],'Changed runtime lines require meaningful coverage');
