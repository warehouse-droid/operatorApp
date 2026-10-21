import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {readFileSync,writeFileSync,readdirSync,cpSync,mkdtempSync,symlinkSync,mkdirSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {resolve} from 'node:path';
import coverage from 'istanbul-lib-coverage';
assert.equal(process.env.MBT_TEST_ISOLATED,'1');assert.ok(process.env.DATABASE_URL?.endsWith('/mbt_verify'));
const out='test-artifacts/special-workflow-review/rest-orders';
const runtime=JSON.parse(readFileSync(`${out}/runtime-files.json`));
const tests=['unit','property','integration'].flatMap(kind=>readdirSync(`test/mbt/${kind}`).filter(name=>/^special-.*\.test\.js$/.test(name)).sort().map(name=>`test/mbt/${kind}/${name}`));
const own=tests.filter(file=>/rest-orders|adjustment|special-workflow-pricing|special-stock-request-service/.test(file));
own.push('test/mbt/unit/special-workflow-pdf-stream-length.test.js');
const toolFiles=readdirSync('tools').filter(name=>/^special-workflow-rest-orders-.*\.(mjs|py|sh)$/.test(name)).map(name=>`tools/${name}`);
toolFiles.push('tools/special-workflow-discount-convert-000007.mjs');
const supportFiles=['test/field-sales/pdf-text.js'];
function run(name,command,args,failure=false,cwd=process.cwd()){
 const result=spawnSync(command,args,{cwd,encoding:'utf8',timeout:300000,maxBuffer:25*1024*1024});
 const log=(result.stdout||'')+(result.stderr||'');writeFileSync(`${out}/${name}.txt`,log);
 if(failure)assert.ok(result.status!==0 && /^not ok /m.test(log),`${name} survived`);
 else assert.equal(result.status,0,`${name} failed; see ${out}/${name}.txt`);
 console.log(JSON.stringify({check:name,passed:true}));return log;
}
const suite=run('related-tests','node_modules/.bin/c8',['--all=false','--check-coverage=false',...runtime.map(file=>`--include=${file}`),`--temp-directory=${out}/c8`,`--report-dir=${out}/coverage`,'--reporter=json',process.execPath,'--test','--test-concurrency=1',...tests]);
run('types','node_modules/.bin/tsc',['--noEmit','--allowJs','--checkJs','--skipLibCheck','--types','node','--target','ES2022','--module','NodeNext','public/special-stock-pricing.js','src/special-stock-adjustment-adapter.js','src/special-stock-rest-orders.js']);
for(const file of [...runtime,...toolFiles.filter(file=>file.endsWith('.mjs'))])run(`syntax-${file.split('/').pop()}`,process.execPath,['--check',file]);
run('lint','node_modules/.bin/eslint',['--config','tools/special-workflow-native-eslint.config.mjs','--max-warnings=0',...runtime,...own,...supportFiles,...toolFiles.filter(file=>file.endsWith('.mjs'))]);
const measured=coverage.createCoverageMap(JSON.parse(readFileSync(`${out}/coverage/coverage-final.json`)));
const changed=new Map();let file;
for(const line of readFileSync(`${out}/runtime.diff`,'utf8').split('\n')){
 if(line.startsWith('+++ b/server/'))file=line.slice('+++ b/server/'.length);
 const hunk=/^@@ .* \+(\d+)(?:,(\d+))? @@/.exec(line);if(!hunk||!runtime.includes(file))continue;
 const numbers=changed.get(file)||new Set();changed.set(file,numbers);
 for(let n=Number(hunk[1]);n<Number(hunk[1])+Number(hunk[2]??1);n++)numbers.add(n);
}
const report={covered:0,total:0,uncovered:[],branches:{covered:0,total:0}};
for(const [file,lines]of changed){
 const entry=measured.fileCoverageFor(resolve(file)),counts=entry.getLineCoverage();
 for(const line of lines){if(!Object.hasOwn(counts,line))continue;report.total++;if(counts[line])report.covered++;else report.uncovered.push(`${file}:${line}`);}
 for(const [key,branch]of Object.entries(entry.branchMap))if(lines.has(branch.line))for(const count of entry.b[key]){report.branches.total++;if(count)report.branches.covered++;}
}
writeFileSync(`${out}/changed-lines.json`,JSON.stringify(report,null,2));
console.log(JSON.stringify({coverage:report}));
assert.deepEqual(report.uncovered,[],'Changed runtime lines need meaningful verification');
const mutations=[
 ['public/special-stock-pricing.js','const grossCents = BigInt(Math.round(specialLineSubtotal(quantity, rate, 0) * 100));','const grossCents = BigInt(Math.round(specialLineSubtotal(1, rate, 0) * 100));'],
 ['public/special-stock-pricing.js','return discountCents === 0n ? 0 : -Number(discountCents) / 100;','return discountCents === 0n ? 0 : Number(discountCents) / 100;'],
 ['src/special-stock-rest-orders.js',"if (!['A', 'B'].includes(row.status)","if (!['A', 'C'].includes(row.status)"],
 ['src/special-stock-rest-orders.js','const payload = { line: Number(source.line) };','const payload = {};'],
 ['src/special-stock-rest-orders.js','if (specialAdjustmentMatches(order.target, current.snapshot)) return;','if (false) return;']
];
const mutationRoot=mkdtempSync('/tmp/special-rest-mutations-');
for(const directory of ['src','public'])cpSync(directory,`${mutationRoot}/${directory}`,{recursive:true});
cpSync('package.json',`${mutationRoot}/package.json`);symlinkSync(resolve('node_modules'),`${mutationRoot}/node_modules`,'dir');
mkdirSync(`${mutationRoot}/test/mbt/unit`,{recursive:true});
cpSync('test/mbt/unit/special-workflow-rest-orders.test.js',`${mutationRoot}/test/mbt/unit/special-workflow-rest-orders.test.js`);
for(const [index,[file,before,after]]of mutations.entries()){
 const target=resolve(mutationRoot,file),source=readFileSync(target,'utf8');assert.equal(source.split(before).length,2);
 try{writeFileSync(target,source.replace(before,after));
  run(`mutant-${index+1}-contract`,process.execPath,['--test','test/mbt/unit/special-workflow-rest-orders.test.js'],true,mutationRoot);
  run(`mutant-${index+1}-property`,process.execPath,['--test','--test-name-pattern=^property:','test/mbt/unit/special-workflow-rest-orders.test.js'],true,mutationRoot);
 }finally{writeFileSync(target,source);}
 assert.equal(readFileSync(file,'utf8'),source);
}
run('suite-health',process.execPath,['--test','--test-concurrency=1',...own.toReversed()]);
run('secrets',process.execPath,['test/support/scan-diff-secrets.mjs',...runtime,...own,...supportFiles,...toolFiles]);
const files=[...new Set([...runtime,...tests,...supportFiles,...toolFiles,'test/special-workflow-rest-orders-spec.md'])];
const hashes=Object.fromEntries(files.map(file=>[file,createHash('sha256').update(readFileSync(file)).digest('hex')]));
writeFileSync(`${out}/source-manifest.json`,JSON.stringify(hashes,null,2));
const summary={completed:true,tests:Number(/^# tests (\d+)$/m.exec(suite)?.[1]),passed:Number(/^# pass (\d+)$/m.exec(suite)?.[1]),
 coverage:report,contractMutants:5,propertyMutants:5,sourceHash:createHash('sha256').update(JSON.stringify(hashes)).digest('hex'),
 tools:{node:process.version,...Object.fromEntries(['typescript','eslint','c8','fast-check'].map(name=>[name,JSON.parse(readFileSync(`node_modules/${name}/package.json`)).version]))}};
writeFileSync(`${out}/summary.json`,JSON.stringify(summary,null,2));console.log(JSON.stringify(summary));
