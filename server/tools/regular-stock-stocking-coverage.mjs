import {readFileSync,writeFileSync,readdirSync,existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import assert from 'node:assert/strict';
import coverage from 'istanbul-lib-coverage';
import v8ToIstanbul from 'v8-to-istanbul';

const out='test-artifacts/regular-stock-stocking';
const files=JSON.parse(readFileSync('tools/regular-stock-stocking-files.json')).filter(file=>file.endsWith('.js'));
if(process.argv.includes('--collect')){
  // The repository-wide MBT percentage includes unrelated modules. Measure this
  // task's added lines explicitly below; do not present a global percentage as a gate.
  const result=spawnSync(process.execPath,['node_modules/c8/bin/c8.js','--all=false','--check-coverage=false',
    ...files.map(file=>`--include=${file}`),'--temp-directory=/tmp/regular-stock-stocking-c8',
    `--report-dir=${out}/coverage`,'--reporter=json','--reporter=json-summary',
    process.execPath,'tools/regular-stock-v2-tests.mjs'],{stdio:'inherit',env:process.env});
  process.exit(result.status||0);
}
const measured=coverage.createCoverageMap(JSON.parse(readFileSync(`${out}/coverage/coverage-final.json`)));
if(existsSync(`${out}/coverage-browser/coverage-final.json`))measured.merge(JSON.parse(readFileSync(`${out}/coverage-browser/coverage-final.json`)));
const browserOut='test-artifacts/regular-stock-v2';
for(const name of readdirSync(browserOut).filter(name=>/^browser-coverage-.*\.json$/.test(name))){
  for(const entry of JSON.parse(readFileSync(`${browserOut}/${name}`))){
    if(!entry.url.startsWith('http'))continue;
    const file=`public/${new URL(entry.url).pathname.split('/').pop()}`;
    if(!files.includes(file))continue;
    const source=readFileSync(file,'utf8');assert.equal(entry.source,source,'Browser coverage source drift');
    const converter=v8ToIstanbul(resolve(file),0,{source});await converter.load();
    converter.applyCoverage(entry.functions);measured.merge(converter.toIstanbul());
  }
}
const changed=new Map();let file,lineNumber=0;
for(const line of readFileSync('test/regular-stock-stocking.changes.patch','utf8').split('\n')){
  if(line.startsWith('+++ b/server/')){file=line.slice('+++ b/server/'.length);continue;}
  const hunk=/^@@ .* \+(\d+)(?:,\d+)? @@/.exec(line);
  if(hunk){lineNumber=Number(hunk[1]);continue;}
  if(line.startsWith('+')){if(files.includes(file)){if(!changed.has(file))changed.set(file,new Set());changed.get(file).add(lineNumber);}lineNumber++;}
  else if(line.startsWith(' '))lineNumber++;
}
const report={covered:0,total:0,uncovered:[],nonExecutableLines:[],missingFiles:[],files:{},branches:{covered:0,total:0,uncovered:[]}};
for(const [file,added] of changed){
  if(!measured.files().includes(resolve(file))){report.missingFiles.push(file);continue;}
  const entry=measured.fileCoverageFor(resolve(file)),lines=entry.getLineCoverage();
  const detail=report.files[file]={covered:0,total:0};
  const sourceLines=readFileSync(file,'utf8').split('\n');
  for(const number of added){
    // V8 includes blank/comment and delimiter-only lines in enclosing ranges.
    // A moved closing brace can therefore look like an uncovered addition even
    // when its function is unchanged. Record these separately for every file.
    if(/^\s*(?:\/\/.*|[{}\[\]();,]*)\s*$/.test(sourceLines[number-1])){report.nonExecutableLines.push(`${file}:${number}`);continue;}
    if(!Object.hasOwn(lines,number))continue;
    report.total++;detail.total++;
    if(lines[number]){report.covered++;detail.covered++;}else report.uncovered.push(`${file}:${number}`);
  }
  for(const [id,branch] of Object.entries(entry.branchMap)){
    if(!added.has(branch.line))continue;
    for(const count of entry.b[id]){report.branches.total++;if(count)report.branches.covered++;else report.branches.uncovered.push(`${file}:${branch.line}`);}
  }
}
report.complete=report.uncovered.length===0&&report.missingFiles.length===0;
writeFileSync(`${out}/changed-lines.json`,JSON.stringify(report,null,2));
console.log(JSON.stringify({changedLines:`${report.covered}/${report.total}`,branches:`${report.branches.covered}/${report.branches.total}`,missingFiles:report.missingFiles,complete:report.complete}));
if(process.argv.includes('--require-complete'))assert.ok(report.complete,'Changed runtime lines remain unexercised; see changed-lines.json');
