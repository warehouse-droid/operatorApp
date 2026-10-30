import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdir,readFile,rm,readdir} from 'node:fs/promises';
import {writeFileSync} from 'node:fs';

const out='test-artifacts/special-independent-po';
await rm(out,{recursive:true,force:true});await mkdir(out,{recursive:true});
let step=0;
function run(command,args) {
  const result=spawnSync(command,args,{encoding:'utf8',env:process.env,maxBuffer:32*1024*1024});
  const output=(result.stdout || '')+(result.stderr || '');
  writeFileSync(`${out}/step-${++step}.log`,output);
  console.log(`Check ${step}: ${command} ${args.slice(0,4).join(' ')}`);
  if(result.status!==0) {console.error(output.slice(-18000));process.exit(result.status || 1);}
  console.log(output.split('\n').filter(line=>/^# (tests|pass|fail|skipped)|^Killed:|^Manual mutations:|^Property-only|\.js\s+\|/.test(line)).join('\n') || 'Passed');
}
run('node_modules/.bin/tsc',['--noEmit','--allowJs','--checkJs','--skipLibCheck','--target','ES2022','--module','NodeNext',
  'src/special-stock-purchase-units.js','src/special-stock-purchase-review.js','public/special-stock-po-editor.js']);
run('node_modules/.bin/eslint',['--config','eslint.special-independent-po.config.js','--max-warnings=0',
  'src/special-stock-purchase-units.js','src/special-stock-purchase-review.js','public/special-stock-po-editor.js']);
const units=['test/mbt/unit/special-independent-po.test.js','test/mbt/unit/special-stock-request-service.red.test.js',
  'test/mbt/unit/special-stock-request-netsuite.red.test.js','test/mbt/unit/special-stock-rest-units.test.js',
  'test/mbt/unit/special-po-line-discount.test.js','test/mbt/unit/special-workflow-native-po.test.js',
  'test/mbt/unit/special-local-adjustments.test.js'];
const integrations=['test/mbt/integration/special-independent-po.test.js',
  'test/mbt/integration/special-independent-po-http.test.js',
  'test/mbt/integration/special-manual-so-link.test.js','test/mbt/integration/special-po-so-note.test.js',
  'test/mbt/integration/special-order-rejection-unlock.test.js'];
// The repository's global MBT coverage gate is for another subsystem. Report
// the affected legacy modules, then enforce coverage on the new focused modules.
run('node_modules/.bin/c8',['--all=false','--check-coverage=false','--include=src/special-stock-purchase-units.js',
  '--include=src/special-stock-purchase-review.js','--include=src/special-stock-request-service.js',
  '--include=src/special-stock-request-netsuite.js','--include=src/special-stock-request-repository.js',
  `--temp-directory=${out}/v8`,`--report-dir=${out}/coverage`,'--reporter=text','--reporter=json',
  'node','--test','--test-concurrency=1',...units,...integrations]);
const coverage=JSON.parse(await readFile(`${out}/coverage/coverage-final.json`,'utf8'));
for(const name of ['special-stock-purchase-units.js','special-stock-purchase-review.js']) {
  const entry=Object.values(coverage).find(entry=>entry.path.endsWith('/'+name));
  if(!entry || Object.values(entry.s).some(hits=>hits===0))throw Error(`Uncovered statements in ${name}`);
  console.log(`Coverage: ${name}, ${Object.keys(entry.s).length}/${Object.keys(entry.s).length} statements executed`);
}
run('node',['--test','--test-concurrency=1','test/mbt/integration/special-independent-po-browser.test.js']);
run('node',['tools/special-independent-po-mutations.mjs']);
run('node',['--test','--test-concurrency=1',...units.toReversed()]);
run('node',['tools/special-independent-po-regressions.mjs']);
const files=['src/special-stock-purchase-units.js','src/special-stock-purchase-review.js',
  'src/special-stock-request-service.js','src/special-stock-request-netsuite.js',
  'src/special-stock-request-repository.js','src/special-stock-local-adjustments.js',
  'src/netsuite.js','src/server.js','public/special-stock-po-editor.js',
  'public/scm-special-stock-requests.js','public/scm-stock-requests.html'];
for(const file of files.filter(file=>file.endsWith('.js'))) {run('node',['--check',file]);}
const hash=createHash('sha256'),fileHashes={};
for(const file of [...files,...(await readdir('migrations')).filter(file=>file.includes('independent_po')).map(file=>'migrations/'+file)].sort()) {
  const content=await readFile(file);hash.update(file);hash.update(content);
  fileHashes[file]=createHash('sha256').update(content).digest('hex');
}
console.log('Source SHA256',hash.digest('hex'));
const versions={node:process.version};
for(const name of ['typescript','eslint','c8','fast-check','@playwright/test']) {
  versions[name]=JSON.parse(await readFile('node_modules/'+name+'/package.json','utf8')).version;
}
console.log('RESULT_JSON '+JSON.stringify({passed:true,files:fileHashes,versions}));
