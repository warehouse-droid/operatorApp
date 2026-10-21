import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {readFileSync,writeFileSync,mkdtempSync,cpSync,symlinkSync,rmSync} from 'node:fs';
import {resolve} from 'node:path';
const unit='test/mbt/unit/special-stock-transfer.test.js',integration='test/mbt/integration/special-stock-transfer.test.js';
const mutations=[
 {name:'four-working-days',file:'public/special-stock-transfer-eta.js',from:'let remaining = 5;',to:'let remaining = 4;',test:unit,property:true},
 {name:'count-holidays',file:'public/special-stock-transfer-eta.js',from:'if (isSpecialWorkingDay(date)) remaining--;',to:'if (![0,6].includes(date.getUTCDay())) remaining--;',test:unit,property:true},
 {name:'accept-relative-production',file:'src/special-stock-request-domain.js',from:'new Set(["dated", "no_projection"])',to:'new Set(["dated", "no_projection", "so_placement"])',test:unit},
 {name:'require-fixed-eta-for-acceptance',file:'src/special-stock-request-repository.js',from:' && !isSpecialTransferEta(mapLine(line))',to:'',test:integration},
 {name:'skip-pending-etas',file:'src/special-stock-request-repository.js',from:'AND available_date IS NULL AND removed_at IS NULL',to:'AND available_date IS NOT NULL AND removed_at IS NULL',test:integration},
 {name:'skip-readiness-date-validation',file:'src/special-stock-request-repository.js',from:'if (!input.ready && !pendingPlacement && (',to:'if (false && (',test:integration},
 {name:'forget-placement-date',file:'src/special-stock-request-repository.js',from:'return dateValue(special.sales_order_placed_date)',to:'return null',test:integration}
];
const temp=mkdtempSync('/tmp/transfer-eta-mutants-'),out=resolve('test-artifacts/transfer-eta-20261016'),results=[];
try {
 for(const folder of ['src','public','test'])cpSync(folder,`${temp}/${folder}`,{recursive:true});
 cpSync('package.json',`${temp}/package.json`);symlinkSync(resolve('node_modules'),`${temp}/node_modules`,'dir');
 for(const mutation of mutations) {
  const source=readFileSync(mutation.file,'utf8');assert.equal(source.split(mutation.from).length,2,mutation.name);
  writeFileSync(`${temp}/${mutation.file}`,source.replace(mutation.from,mutation.to));
  try {
   for(const propertyOnly of mutation.property?[false,true]:[false]) {
    const run=spawnSync(process.execPath,['--test',...(propertyOnly?['--test-name-pattern=property:']:[]),mutation.test],{cwd:temp,env:process.env,encoding:'utf8',timeout:60000,maxBuffer:8*1024*1024});
    const log=(run.stdout||'')+(run.stderr||'');writeFileSync(`${out}/mutant-${mutation.name}${propertyOnly?'-property':''}.log`,log);
    assert.ok(run.status!==0 && /^not ok /m.test(log),mutation.name+' survived');results.push({name:mutation.name,propertyOnly,killed:true});
   }
  }finally{writeFileSync(`${temp}/${mutation.file}`,source);}
 }
}finally{rmSync(temp,{recursive:true,force:true});}
writeFileSync(`${out}/mutations.json`,JSON.stringify(results,null,2));console.log(JSON.stringify({mutantsKilled:mutations.length,propertyMutantsKilled:2}));
