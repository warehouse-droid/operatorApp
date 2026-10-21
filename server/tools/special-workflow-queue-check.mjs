import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {readFileSync,writeFileSync,readdirSync,cpSync,mkdtempSync,symlinkSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {resolve} from 'node:path';
assert.equal(process.env.MBT_TEST_ISOLATED,'1');assert.ok(process.env.DATABASE_URL?.endsWith('/mbt_verify'));
const out='test-artifacts/special-workflow-review/queue-access';
const runtime=JSON.parse(readFileSync(`${out}/runtime-files.json`));
const tests=['unit','property','integration'].flatMap(kind=>readdirSync(`test/mbt/${kind}`).filter(name=>/^special-.*\.test\.js$/.test(name)).sort().map(name=>`test/mbt/${kind}/${name}`));
const own=tests.filter(file=>/queue|native-documents|special-workflow-pricing-http/.test(file));
own.push('test/mbt/unit/special-workflow-pdf-stream-length.test.js');
const toolFiles=readdirSync('tools').filter(name=>/^special-workflow-queue-.*\.(mjs|py|sh)$/.test(name)).map(name=>`tools/${name}`);

const supportFiles=['src/netsuite-restlet-harness.js'];
function run(name,command,args,failure=false,cwd=process.cwd()){
 const result=spawnSync(command,args,{cwd,encoding:'utf8',timeout:300000,maxBuffer:25*1024*1024});
 const log=(result.stdout||'')+(result.stderr||'');writeFileSync(`${out}/${name}.txt`,log);
 if(failure)assert.ok(result.status!==0 && /^not ok /m.test(log),`${name} survived`);
 else assert.equal(result.status,0,`${name} failed; see ${out}/${name}.txt`);
 console.log(JSON.stringify({check:name,passed:true}));return log;
}
const suite=run('related-tests','node_modules/.bin/c8',['--all=false','--check-coverage=false',...runtime.filter(file=>file.endsWith('.js')).map(file=>`--include=${file}`),`--temp-directory=${out}/c8`,`--report-dir=${out}/coverage`,'--reporter=json',process.execPath,'--test','--test-concurrency=1',...tests]);
run('types','node_modules/.bin/tsc',['--noEmit','--allowJs','--checkJs','--skipLibCheck','--types','node','--target','ES2022','--module','NodeNext','public/special-stock-queue.js']);
for(const file of [...runtime.filter(file=>file.endsWith('.js')),...toolFiles.filter(file=>file.endsWith('.mjs'))])run(`syntax-${file.split('/').pop()}`,process.execPath,['--check',file]);
run('lint','node_modules/.bin/eslint',['--config','tools/special-workflow-queue-eslint.config.mjs','--max-warnings=0',...runtime.filter(file=>file.endsWith('.js')&&file!=='src/server.js'),...own,...supportFiles,...toolFiles.filter(file=>file.endsWith('.mjs'))]);
run('server-lint-baseline',process.execPath,['tools/special-workflow-queue-server-lint.mjs']);
run('restlet',process.execPath,['src/netsuite-restlet-harness.js']);
run('browser',process.execPath,['tools/special-workflow-queue-browser.mjs']);
run('coverage',process.execPath,['tools/special-workflow-queue-coverage.mjs','--require-complete']);
const report=JSON.parse(readFileSync(`${out}/changed-lines.json`));
const mutations=[
 ['public/special-stock-queue.js','if (current!==generation || revision!==invalidation) return;','if (revision!==invalidation) return;','test/mbt/unit/special-workflow-queue.test.js'],
 ['public/special-stock-queue.js','String(id)===String(orderId)','String(id)!==String(orderId)','test/mbt/unit/special-workflow-queue.test.js'],
 ['src/special-stock-request-repository.js','clauses.push(`request.destination_location_id = $${params.length}`);','params.pop();','test/mbt/integration/special-workflow-queue-access.test.js']
];
const mutationRoot=mkdtempSync('/tmp/special-queue-mutations-');
for(const directory of ['src','public','test/mbt/unit','test/mbt/integration'])cpSync(directory,`${mutationRoot}/${directory}`,{recursive:true});
cpSync('package.json',`${mutationRoot}/package.json`);symlinkSync(resolve('node_modules'),`${mutationRoot}/node_modules`,'dir');
for(const [index,[file,before,after,testFile]]of mutations.entries()){
 const target=resolve(mutationRoot,file),source=readFileSync(target,'utf8');assert.equal(source.split(before).length,2);
 try{writeFileSync(target,source.replace(before,after));
  run(`mutant-${index+1}-contract`,process.execPath,['--test',testFile],true,mutationRoot);
  run(`mutant-${index+1}-property`,process.execPath,['--test','--test-name-pattern=^property:',testFile],true,mutationRoot);
 }finally{writeFileSync(target,source);}
 assert.equal(readFileSync(file,'utf8'),source);
}
run('suite-health',process.execPath,['--test','--test-concurrency=1',...own.toReversed()]);
run('secrets',process.execPath,['test/support/scan-diff-secrets.mjs',...runtime,...own,...supportFiles,...toolFiles]);
const files=[...new Set([...runtime,...tests,...supportFiles,...toolFiles,'test/special-workflow-queue-access-spec.md'])];
const hashes=Object.fromEntries(files.map(file=>[file,createHash('sha256').update(readFileSync(file)).digest('hex')]));
writeFileSync(`${out}/source-manifest.json`,JSON.stringify(hashes,null,2));
const summary={completed:true,tests:Number(/^# tests (\d+)$/m.exec(suite)?.[1]),passed:Number(/^# pass (\d+)$/m.exec(suite)?.[1]),
 coverage:report,contractMutants:3,propertyMutants:3,sourceHash:createHash('sha256').update(JSON.stringify(hashes)).digest('hex'),
 tools:{node:process.version,...Object.fromEntries(['typescript','eslint','c8','fast-check'].map(name=>[name,JSON.parse(readFileSync(`node_modules/${name}/package.json`)).version]))}};
writeFileSync(`${out}/summary.json`,JSON.stringify(summary,null,2));console.log(JSON.stringify(summary));
