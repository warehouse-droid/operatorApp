import {spawnSync} from 'node:child_process';
import {writeFileSync,mkdirSync,readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {buildIsolatedTestEnvironment} from '../test/support/test-foundation.mjs';
import {runNodeTestFilesIsolated} from '../test/support/test-database-isolation.mjs';

if(process.env.MBT_TEST_ISOLATED!=='1'){throw new Error('Disposable isolated infrastructure is required.');}
const mode=process.argv[2] || 'final';
if(mode==='final' && !process.env.DELIVERY_ENHANCEMENTS_COVERAGE_CHILD) {
  const result=spawnSync('node_modules/.bin/c8',['--config=tools/delivery-request-c8.json','--include=src/delivery-request*.js','--include=src/netsuite.js','--reporter=json','--reporter=text-summary',
    '--reports-dir=test-artifacts/coverage',process.execPath,'tools/delivery-request-enhancements-checks.mjs','final'],
  {stdio:'inherit',env:{...process.env,DELIVERY_ENHANCEMENTS_COVERAGE_CHILD:'1'}});
  process.exit(result.status ?? 1);
}
const regressions=['unit/delivery-request-domain','unit/delivery-request-expiry','unit/delivery-request-router',
  'property/delivery-request-domain.property','integration/delivery-requests','integration/delivery-requests-http',
  'integration/delivery-request-planning','integration/delivery-requests-browser','integration/delivery-request-event-stream-browser',
  'integration/delivery-request-cards-browser','integration/delivery-instruction-repository','integration/delivery-instruction-http'];
const additions=['unit/delivery-request-enhancements','unit/delivery-request-documents','integration/delivery-request-enhancements','integration/delivery-request-enhancements-browser'];
const files=(mode==='red'?additions:mode==='baseline'?regressions:[...regressions,...additions]).map(name=>`test/mbt/${name}.test.js`);
mkdirSync('test-artifacts/delivery-requests-ui',{recursive:true});mkdirSync('test-artifacts/delivery-requests',{recursive:true});
const stages=[];
function run(name,args) {
  const result=spawnSync(process.execPath,args,{encoding:'utf8',maxBuffer:16*1024*1024});
  writeFileSync(`test-artifacts/${name}.log`,result.stdout+result.stderr);stages.push({name,exitCode:result.status});
  process.stdout.write(`${name}: ${result.status}\n`);
  if(result.status!==0){process.stdout.write((result.stdout+result.stderr).slice(-6000));process.exit(result.status || 1);}
}
if(mode==='final') {
  run('types',['tools/delivery-request-quality.mjs','types']);run('lint',['tools/delivery-request-static.mjs']);
  run('versions',['tools/delivery-request-quality.mjs','versions']);
}
let seed=6132026;
for(let index=files.length-1;index>0;index--){seed=(Math.imul(seed,1664525)+1013904223)>>>0;const next=seed%(index+1);[files[index],files[next]]=[files[next],files[index]];}
writeFileSync('test-artifacts/suite-order.json',JSON.stringify({seed:6132026,files},null,2)+'\n');
const environment=buildIsolatedTestEnvironment(process.env,{databaseUrl:process.env.DATABASE_URL || ''});
process.exitCode=await runNodeTestFilesIsolated(files,{environment:{...environment,DELIVERY_UI_COVERAGE:mode==='final'?'1':'0'},label:`Delivery enhancements ${mode}`});
stages.push({name:'tests',exitCode:process.exitCode});
writeFileSync('test-artifacts/stages.json',JSON.stringify(stages,null,2)+'\n');
if(mode==='final' && !process.exitCode) {
  const runtime=['src/delivery-request-domain.js','src/delivery-request-documents.js','src/delivery-request-repository.js',
    'src/delivery-request-router.js','public/delivery-requests.js','public/delivery-requests.css','public/delivery-request-alert.js','src/netsuite.js'];
  const hashes=Object.fromEntries(runtime.map(file=>[file,createHash('sha256').update(readFileSync(file)).digest('hex')]));
  writeFileSync('test-artifacts/source-hashes.json',JSON.stringify(hashes,null,2)+'\n');
}
