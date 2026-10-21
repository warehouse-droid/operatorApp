import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,readdirSync,existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import coverage from 'istanbul-lib-coverage';
import v8ToIstanbul from 'v8-to-istanbul';
const out='test-artifacts/regular-stock-purchase';
const files=JSON.parse(readFileSync('tools/regular-stock-purchase-files.json')).filter(file=>file.endsWith('.js'));
if(process.argv.includes('--collect-browser')){
  const result=spawnSync(process.execPath,['node_modules/c8/bin/c8.js','report',
    '--all=false','--check-coverage=false',
    ...files.map(file=>`--include=${file}`),`--temp-directory=${out}/browser-node-v8-final`,
    `--report-dir=${out}/coverage-browser-node`,'--reporter=json','--reporter=json-summary'],{stdio:'inherit'});
  process.exit(result.status??1);
}
if(process.argv.includes('--collect')){
  const result=spawnSync(process.execPath,['node_modules/c8/bin/c8.js','--all=false','--check-coverage=false',
    ...files.map(file=>`--include=${file}`),'--temp-directory=/tmp/regular-stock-purchase-c8',`--report-dir=${out}/coverage`,
    '--reporter=json','--reporter=json-summary',process.execPath,'tools/regular-stock-purchase-tests.mjs'],{stdio:'inherit'});
  process.exit(result.status??1);
}
assert(existsSync(`${out}/coverage/coverage-final.json`),'Collect backend coverage before reporting');
const measured=coverage.createCoverageMap(JSON.parse(readFileSync(`${out}/coverage/coverage-final.json`)));
if(existsSync(`${out}/coverage-browser-node/coverage-final.json`))measured.merge(JSON.parse(readFileSync(`${out}/coverage-browser-node/coverage-final.json`)));
for(const name of readdirSync(out).filter(name=>/^browser-coverage-.*\.json$/.test(name))){
  for(const entry of JSON.parse(readFileSync(`${out}/${name}`))){
    if(!entry.url.startsWith('http'))continue;
    const file=`public/${new URL(entry.url).pathname.split('/').pop()}`;
    if(!files.includes(file))continue;
    const source=readFileSync(file,'utf8');
    if(entry.source!==source)continue;
    const converter=v8ToIstanbul(resolve(file),0,{source});await converter.load();converter.applyCoverage(entry.functions);measured.merge(converter.toIstanbul());
  }
}
const changed=new Map();let file,lineNumber=0;
for(const line of readFileSync('test/regular-stock-purchase.changes.patch','utf8').split('\n')){
  if(line.startsWith('+++ b/')){file=line.slice(6);continue;}
  const hunk=/^@@ .* \+(\d+)(?:,\d+)? @@/.exec(line);if(hunk){lineNumber=Number(hunk[1]);continue;}
  if(line.startsWith('+')){if(files.includes(file)){if(!changed.has(file))changed.set(file,new Set());changed.get(file).add(lineNumber);}lineNumber++;}
  else if(line.startsWith(' '))lineNumber++;
}
const report={covered:0,total:0,uncovered:[],nonExecutableLines:[],missingFiles:[],files:{},branches:{covered:0,total:0}};
for(const [file,added] of changed){
  if(!measured.files().includes(resolve(file))){report.missingFiles.push(file);continue;}
  const entry=measured.fileCoverageFor(resolve(file)),lines=entry.getLineCoverage(),sourceLines=readFileSync(file,'utf8').split('\n');
  const detail=report.files[file]={covered:0,total:0};
  for(const number of added){
    if(/^\s*(?:\/\/.*|\/\*\*.*\*\/|[{}\[\]();,]*)\s*$/.test(sourceLines[number-1])){report.nonExecutableLines.push(`${file}:${number}`);continue;}
    if(!Object.hasOwn(lines,number))continue;
    report.total++;detail.total++;
    if(lines[number]){report.covered++;detail.covered++;}else report.uncovered.push(`${file}:${number}`);
  }
  for(const [id,branch] of Object.entries(entry.branchMap))if(added.has(branch.line))for(const count of entry.b[id]){report.branches.total++;if(count)report.branches.covered++;}
}
report.complete=report.uncovered.length===0&&report.missingFiles.length===0;
writeFileSync(`${out}/changed-lines.json`,JSON.stringify(report,null,2));
writeFileSync(`${out}/coverage-combined.json`,JSON.stringify(measured.toJSON()));
console.log(JSON.stringify({changedLines:`${report.covered}/${report.total}`,branches:`${report.branches.covered}/${report.branches.total}`,missingFiles:report.missingFiles,uncovered:report.uncovered}));
process.exitCode=report.complete?0:1;
