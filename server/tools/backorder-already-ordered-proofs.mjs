import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {cp,mkdtemp,mkdir,readFile,writeFile,symlink,rm,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createHash} from 'node:crypto';
import v8toIstanbul from 'v8-to-istanbul';
import istanbulCoverage from 'istanbul-lib-coverage';
import {ESLint} from 'eslint';

assert.equal(process.env.MBT_TEST_ISOLATED,'1');
const sourceFiles=['public/backorder-workflow.js','public/backorder-stock-requests.js','src/backorder-request-service.js','src/special-stock-request-repository.js'];
const hashes=Object.fromEntries(await Promise.all(sourceFiles.map(async file=>[file,createHash('sha256').update(await readFile(file)).digest('hex')])));
const final=JSON.parse(await readFile('/final/report.json','utf8'));assert(final.passed);assert.deepEqual(hashes,final.hashes);
const eslint=new ESLint({overrideConfigFile:'tools/regular-stock-v2-eslint.config.mjs'});
const lintResults=await eslint.lintFiles(['test/mbt/helpers/backorder-already-ordered.js',
  'test/mbt/integration/backorder-already-ordered*.test.js','test/mbt/property/backorder-already-ordered.property.test.js',
  'tools/backorder-already-ordered-*.mjs']);
const lintMessages=lintResults.flatMap(result=>result.messages.map(message=>({file:result.filePath,...message})));
await writeFile('test-artifacts/test-tool-lint.json',JSON.stringify(lintMessages,null,2));assert.deepEqual(lintMessages,[]);
const coverageMap=istanbulCoverage.createCoverageMap(JSON.parse(await readFile('/final/coverage/coverage-final.json','utf8')));
for(const file of await readdir('/final/browser')) {
  if(!file.endsWith('.coverage.json'))continue;
  for(const entry of JSON.parse(await readFile('/final/browser/'+file,'utf8'))) {
    const path='public'+new URL(entry.url).pathname;
    if(!sourceFiles.includes(path))continue;
    assert.equal(createHash('sha256').update(entry.source).digest('hex'),hashes[path]);
    const converter=v8toIstanbul(resolve(path),0,{source:entry.source});await converter.load();converter.applyCoverage(entry.functions);coverageMap.merge(converter.toIstanbul());
  }
}
const changed=JSON.parse(await readFile('/changed-lines.json','utf8')),coverage={lines:[],uncoveredLines:[],branches:[]};
for(const [file,lines] of Object.entries(changed)) {
  const measured=coverageMap.fileCoverageFor(resolve(file)),hits=measured.getLineCoverage();
  for(const line of lines) {
    const row={file,line,hits:hits[line] || 0};coverage.lines.push(row);if(!row.hits)coverage.uncoveredLines.push(row);
  }
  for(const [id,branch] of Object.entries(measured.branchMap))if(lines.includes(branch.loc.start.line))coverage.branches.push({file,line:branch.loc.start.line,hits:measured.b[id]});
}
await writeFile('test-artifacts/changed-coverage.json',JSON.stringify(coverage,null,2));
assert.deepEqual(coverage.uncoveredLines,[],'Changed lines need meaningful executable coverage');
const files=['test/mbt/integration/backorder-already-ordered.test.js','test/mbt/property/backorder-already-ordered.property.test.js'];
const temporary=await mkdtemp(join(tmpdir(),'already-ordered-mutants-')),mutants=[];
async function run(name,args) {
  const result=spawnSync(process.execPath,args,{cwd:temporary,encoding:'utf8',maxBuffer:20_000_000,timeout:120000});
  const output=(result.stdout || '')+(result.stderr || '');await writeFile('test-artifacts/'+name+'.log',output);
  assert.equal(result.signal,null);
  return {exitCode:result.status,failures:[...output.matchAll(/^not ok \d+ - (.+)$/gm)].map(match=>match[1])};
}
try {
  for(const folder of ['src','public'])await cp(folder,join(temporary,folder),{recursive:true});
  await mkdir(join(temporary,'test/mbt'),{recursive:true});
  for(const folder of ['helpers','integration','property'])await cp('test/mbt/'+folder,join(temporary,'test/mbt',folder),{recursive:true});
  await cp('package.json',join(temporary,'package.json'));await symlink(resolve('node_modules'),join(temporary,'node_modules'),'dir');
  const mutations=[
    ['completed lines block PO readiness','public/backorder-workflow.js',"line.supplyStatus !== 'already_ordered' && ",'',true],
    ['all ordered cases incorrectly close','public/backorder-workflow.js',"evidence.hasAlreadyOrderedLines ? 'completed' : 'closed'","'closed'",true],
    ['PO number becomes optional','src/backorder-request-service.js',"'PO number',120,true","'PO number',120,false",false],
    ['references stored without trimming','src/backorder-request-service.js','return text.trim();','return text;',true],
    ['completed lines can be reopened','public/backorder-workflow.js',"if (supplyStatus === 'already_ordered')","if (supplyStatus === 'never')",false],
    ['missing completion audit','src/backorder-request-service.js',"await localEvent(id,'backorder_already_ordered',","await localEvent(id,'backorder_other_event',",false],
    ['ordered line still triggers SCM review','src/backorder-request-service.js',"review.supply_status IS DISTINCT FROM 'already_ordered' AND ",'',false]
  ];
  for(const [index,[name,file,needle,replacement,properties]] of mutations.entries()) {
    const source=await readFile(file,'utf8');assert.equal(source.split(needle).length,2,name+' anchor');
    await writeFile(join(temporary,file),source.replace(needle,replacement));
    const result=await run('mutant-'+index,['--test','--test-concurrency=1',...files]);
    assert.equal(result.exitCode,1,name+' survived');assert(result.failures.some(f=>!f.startsWith('/')));
    let propertyResult;
    if(properties) {
      propertyResult=await run('property-mutant-'+index,['--test','--test-concurrency=1','--test-name-pattern=property:',...files]);
      assert.equal(propertyResult.exitCode,1,name+' survived properties');
    }
    mutants.push({name,killed:true,failures:result.failures,propertyResult});console.log(JSON.stringify(mutants.at(-1)));
    await writeFile(join(temporary,file),source);
  }
  assert.equal((await run('restored',['--test','--test-concurrency=1',...files.toReversed()])).exitCode,0);
  assert.equal((await run('browser-restored',['--test','test/mbt/integration/backorder-already-ordered-browser.test.js'])).exitCode,0);
  assert.equal((await run('schema-rehearsal',['/app/tools/backorder-already-ordered-schema.mjs'])).exitCode,0);
}finally{await rm(temporary,{recursive:true,force:true});}
const versions={node:process.version};
for(const name of ['fast-check','c8','eslint','typescript','playwright'])versions[name]=JSON.parse(await readFile(`node_modules/${name}/package.json`,'utf8')).version;
await writeFile('test-artifacts/report.json',JSON.stringify({passed:true,hashes,coverage,mutants,versions,restoredAndReordered:true,schemaReplayAndRollback:true,testToolLintMessages:lintMessages},null,2));
