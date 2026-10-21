import {readdirSync,mkdirSync,writeFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {runNodeTestFilesIsolated} from '../test/support/test-database-isolation.mjs';

if(process.env.MBT_TEST_ISOLATED!=='1') {throw new Error('Disposable isolated test infrastructure is required.');}
const mode=process.argv[2] || 'green';
const files=['unit','property','integration'].flatMap(folder=>readdirSync(`test/mbt/${folder}`)
  .filter(name=>/^delivery-(?:requests|request-|instruction).*\.test\.js$/.test(name))
  .map(name=>`test/mbt/${folder}/${name}`));
let selected=mode==='red'?files.filter(name=>name.includes('transfer-orders') || name.includes('enhancements-browser'))
  :mode==='baseline'?files.filter(name=>!name.includes('transfer-orders') && !name.includes('enhancements-browser'))
    :mode==='focus'?files.filter(name=>['delivery-requests-browser.test.js','delivery-request-transfer-orders.test.js','delivery-request-event-stream-browser.test.js'].includes(name.split('/').at(-1))):files;
if(!['red','baseline','green','focus'].includes(mode)) {throw new Error('Choose red, baseline, green or focus.');}
mkdirSync('test-artifacts/delivery-requests-ui',{recursive:true});mkdirSync('test-artifacts/delivery-requests',{recursive:true});
let seed=15102026;
selected=[...selected].sort();
for(let i=selected.length-1;i>0;i--) {seed=(Math.imul(seed,1664525)+1013904223)>>>0;const j=seed%(i+1);[selected[i],selected[j]]=[selected[j],selected[i]];}
writeFileSync(`test-artifacts/${mode}-files.json`,JSON.stringify({seed:15102026,files:selected},null,2)+'\n');
process.stdout.write(`Delivery Transfer Orders ${mode}: ${selected.length} suites, shuffle seed 15102026\n`);
process.exitCode=await runNodeTestFilesIsolated(selected,{label:`Delivery transfer ${mode}`});
if(mode==='baseline' || mode==='green') {
  for(const [name,args] of Object.entries({
    types:['node_modules/typescript/bin/tsc','--project','tools/tsconfig.delivery-requests.json','--noEmit'],
    lint:['node_modules/eslint/bin/eslint.js','--config','tools/delivery-request-eslint.config.mjs','--format=json',
      'src/delivery-request*.js','public/delivery-request*.js']
  })) {
    const result=spawnSync(process.execPath,args,{encoding:'utf8'});
    writeFileSync(`test-artifacts/${name}.log`,result.stdout+result.stderr);
    writeFileSync(`test-artifacts/${name}-status.json`,JSON.stringify({exitCode:result.status ?? 1})+'\n');
    process.stdout.write(`${name}: exit ${result.status ?? 1}\n`);
    if(result.status!==0) {process.exitCode=1;}
  }
}
