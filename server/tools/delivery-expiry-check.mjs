import {readdirSync,mkdirSync,writeFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {runNodeTestFilesIsolated} from '../test/support/test-database-isolation.mjs';
const mode=process.argv[2] || 'final';
process.env.DELIVERY_UI_COVERAGE=mode==='final'?'1':'0';
if(process.env.MBT_TEST_ISOLATED!=='1') {throw new Error('Isolated disposable infrastructure required.');}
const all=['unit','property','integration'].flatMap(folder=>readdirSync(`test/mbt/${folder}`)
  .filter(name=>/^delivery-(?:requests|request-|instruction|timeslot).*\.test\.js$/.test(name)).map(name=>`test/mbt/${folder}/${name}`));
const files=all.filter(file=>['red','focus'].includes(mode)?file.includes('expiry-controls'):mode==='baseline'?!file.includes('expiry-controls'):true).sort();
let seed=16102026;
for(let i=files.length-1;i>0;i--) {seed=(Math.imul(seed,1664525)+1013904223)>>>0;const j=seed%(i+1);[files[i],files[j]]=[files[j],files[i]];}
mkdirSync('test-artifacts/delivery-requests-ui',{recursive:true});mkdirSync('test-artifacts/delivery-requests',{recursive:true});
writeFileSync('test-artifacts/suite-order.json',JSON.stringify({seed:16102026,files},null,2)+'\n');
process.exitCode=await runNodeTestFilesIsolated(files,{label:`Delivery expiry ${mode}`});
if(['final','focus'].includes(mode)) {
  for(const [name,args] of Object.entries({
    types:['node_modules/typescript/bin/tsc','--project','tools/tsconfig.delivery-requests.json','--noEmit'],
    lint:['node_modules/eslint/bin/eslint.js','--config','tools/delivery-request-eslint.config.mjs','--max-warnings=0',
      'src/delivery-request-domain.js','src/delivery-request-repository.js','public/delivery-request*.js',
      'test/mbt/unit/delivery-request-expiry-controls.test.js','test/mbt/integration/delivery-request-expiry-controls.test.js',
      'tools/delivery-expiry-check.mjs','tools/delivery-expiry-mutations.mjs','tools/delivery-expiry-coverage.mjs'],
    syntax:['--check','public/delivery-requests.js']
  })) {
    const result=spawnSync(process.execPath,args,{encoding:'utf8'});writeFileSync(`test-artifacts/${name}.log`,result.stdout+result.stderr);
    process.stdout.write(`${name}: ${result.status}\n${result.stdout}${result.stderr}`);if(result.status!==0) {process.exitCode=1;}
  }
}
