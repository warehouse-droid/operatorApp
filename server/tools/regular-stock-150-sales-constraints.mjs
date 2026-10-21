import assert from 'node:assert/strict';
import {readFile,writeFile,mkdtemp,cp,symlink,rm} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {resolve,join} from 'node:path';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {ESLint} from 'eslint';
import coverage from 'istanbul-lib-coverage';
import v8ToIstanbul from 'v8-to-istanbul';

assert.equal(process.env.MBT_TEST_ISOLATED,'1');
const out='test-artifacts',files=JSON.parse(await readFile('tools/regular-stock-150-sales-files.json','utf8'));
const hash=data=>createHash('sha256').update(data).digest('hex'),layers=[];
async function run(name,args,options={}) {
  const result=spawnSync(process.execPath,args,{encoding:'utf8',maxBuffer:20_000_000,timeout:120000,...options});
  const output=(result.stdout||'')+(result.stderr||'');
  await writeFile(`${out}/${name}.log`,output);layers.push({name,exitCode:result.status});
  assert.equal(result.status,0,`${name}: ${output}`);return output;
}
for (const file of files.filter(file=>file.endsWith('.js'))) {
  await run('syntax-'+file.replaceAll('/','-'),['--check',file]);
}
await run('types',['node_modules/typescript/bin/tsc','-p','tools/regular-stock-150-sales-tsconfig.json']);
const lint=new ESLint({overrideConfigFile:'tools/regular-stock-v2-eslint.config.mjs'}),newDiagnostics=[];
const diagnostics=async(source,file)=>(await lint.lintText(source,{filePath:file}))[0].messages
  .map(({ruleId,severity,message})=>JSON.stringify({ruleId,severity,message}));
const additions=['test/mbt/unit/regular-stock-150-sales.test.js','test/mbt/integration/regular-stock-150-sales.test.js',
  ...['tests','browser','constraints','live'].map(name=>'tools/regular-stock-150-sales-'+name+'.mjs')];
for (const file of [...files.filter(file=>file.endsWith('.js')),...additions]) {
  const prior=existsSync(`${out}/before/${file}`)?await diagnostics(await readFile(`${out}/before/${file}`,'utf8'),file):[];
  for (const message of await diagnostics(await readFile(file,'utf8'),file)) {
    const index=prior.indexOf(message);
    if (index<0) {newDiagnostics.push({file,message});} else {prior.splice(index,1);}
  }
}
await writeFile(`${out}/lint.json`,JSON.stringify(newDiagnostics,null,2));assert.deepEqual(newDiagnostics,[]);
const baseline=JSON.parse(await readFile(`${out}/baseline-source.json`,'utf8'));
assert.equal(hash(await readFile('package.json')),baseline.packageSha256,'No dependency changes');

const unit='test/mbt/unit/regular-stock-150-sales.test.js',integration='test/mbt/integration/regular-stock-150-sales.test.js';
for (const [index,file] of [unit,integration].entries()) {
  await run('shuffle-'+index,['--test',file]);
}
const mutations=[
  ['reverse route removed','return from !== null && to !== null && from !== to;','return from === 1 && to === 28;',unit,true],
  ['150 permission removed','return authorized.some(id => Number(id) === 26);','return true;',unit,true],
  ['wrong method admitted',"request.regular?.deliveryMethod === 'delivery'","request.regular !== undefined",unit,true],
  ['initial Base Yard lookup disabled','const discoveringBase = preview && base !== null','const discoveringBase = false && base !== null',unit,false],
  ['historical Delivery admitted to list SQL',"AND request.request_type = 'regular' AND request.workflow_version = 2","AND request.request_type = 'regular'",integration,false]
];
const temporary=await mkdtemp(join(tmpdir(),'sales150-mutations-')),mutants=[];
try {
  for (const folder of ['src','public','test']) {await cp(resolve(folder),join(temporary,folder),{recursive:true});}
  await cp('package.json',join(temporary,'package.json'));await symlink(resolve('node_modules'),join(temporary,'node_modules'),'dir');
  const file='src/regular-stock-delivery-access.js',source=await readFile(file,'utf8');
  for (const [index,[name,needle,replacement,suite,property]] of mutations.entries()) {
    assert.equal(source.split(needle).length,2,name+': unique mutation target');
    await writeFile(join(temporary,file),source.replace(needle,replacement));
    for (const propertiesOnly of property?[false,true]:[false]) {
      const child=spawnSync(process.execPath,['--test',...(propertiesOnly?['--test-name-pattern=property:']:[]),suite],
        {cwd:temporary,encoding:'utf8',maxBuffer:5_000_000,timeout:60000});
      const output=(child.stdout||'')+(child.stderr||'');
      await writeFile(`${out}/mutant-${index}-${propertiesOnly}.log`,output);
      assert.equal(child.status,1,name+': '+output);assert.match(output,/not ok/);
      if (suite===integration) {assert.match(output,/not ok \d+ - SQL and detail scope expose only current regular Delivery requests on the two new routes/);}
    }
    await writeFile(join(temporary,file),source);mutants.push({name,killed:true,propertiesVerified:property});
  }
  assert.equal(await readFile(join(temporary,file),'utf8'),source);
  await run('mutants-restored',['--test',unit,integration],{cwd:temporary});
} finally {await rm(temporary,{recursive:true,force:true});}

const measured=coverage.createCoverageMap(JSON.parse(await readFile(`${out}/coverage/coverage-final.json`,'utf8')));
for (const entry of JSON.parse(await readFile(`${out}/browser-coverage.json`,'utf8'))) {
  if (!entry.url.startsWith('http')) {continue;}
  const file='public/'+new URL(entry.url).pathname.split('/').pop();
  if (!files.includes(file)) {continue;}
  const source=await readFile(file,'utf8');assert.equal(entry.source,source);
  const converter=v8ToIstanbul(resolve(file),0,{source});await converter.load();
  converter.applyCoverage(entry.functions);measured.merge(converter.toIstanbul());
}
const changed=JSON.parse(await readFile(`${out}/changed-source-lines.json`,'utf8'));
const report={covered:0,total:0,uncovered:[],missingFiles:[],branches:{covered:0,total:0}};
for (const [file,added] of Object.entries(changed)) {
  if (!file.endsWith('.js')) {continue;}
  if (!measured.files().includes(resolve(file))) {report.missingFiles.push(file);continue;}
  const entry=measured.fileCoverageFor(resolve(file)),lines=entry.getLineCoverage(),source=(await readFile(file,'utf8')).split('\n');
  for (const number of added) {
    if (/^\s*(?:\/\/.*|\/\*\*?.*|\*.*|[{}\[\]();,]*)\s*$/.test(source[number-1]) || !Object.hasOwn(lines,number)) {continue;}
    report.total++;
    if (lines[number]) {report.covered++;} else {report.uncovered.push(`${file}:${number}`);}
  }
  for (const [id,branch] of Object.entries(entry.branchMap)) {
    if (added.includes(branch.line)) {
      for (const count of entry.b[id]) {report.branches.total++;if (count) {report.branches.covered++;}}
    }
  }
}
await writeFile(`${out}/changed-lines.json`,JSON.stringify(report,null,2));
assert.deepEqual(report.missingFiles,[]);assert.deepEqual(report.uncovered,[],'All changed executable lines must run');
for (const file of files.filter(file=>file.endsWith('.js'))) {
  const source=await readFile(file,'utf8');
  const old=existsSync(`${out}/before/${file}`)?(await readFile(`${out}/before/${file}`,'utf8')).split('\n'):[];
  for (const number of changed[file]) {
    const line=source.split('\n')[number-1];
    if (!old.includes(line)) {assert.doesNotMatch(line,/-----BEGIN|AKIA[0-9A-Z]{16}|Bearer\s+[A-Za-z0-9_-]{20,}|process\.env|child_process/);}
  }
}
const toolchain={node:process.version};
for (const name of ['fast-check','c8','eslint','typescript','playwright']) {
  toolchain[name]=JSON.parse(await readFile(`node_modules/${name}/package.json`,'utf8')).version;
}
const sourceHashes=Object.fromEntries(await Promise.all(files.map(async file=>[file,hash(await readFile(file))])));
const result={sourceHashes,sourceTreeSha256:hash(JSON.stringify(sourceHashes)),layers,mutants,coverage:report,
  toolchain,dependenciesChanged:false,propertyExamples:1900,suiteOrder:[unit,integration]};
await writeFile(`${out}/checks.json`,JSON.stringify(result,null,2));
console.log(JSON.stringify({types:'passed',newLintDiagnostics:0,mutants:mutants.length,coverage:report}));
