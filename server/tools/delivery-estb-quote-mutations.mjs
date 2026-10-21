import assert from 'node:assert/strict';
import {cpSync,symlinkSync,readFileSync,writeFileSync,mkdirSync,rmSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';

assert.equal(process.env.MBT_TEST_ISOLATED,'1');
const scratch='/tmp/delivery-estb-quote-mutations',output='test-artifacts/mutations';
mkdirSync(output,{recursive:true});rmSync(scratch,{recursive:true,force:true});mkdirSync(scratch);
for(const path of ['src','public','test','package.json','netsuite-smart-scm-picking-ticket-restlet.js','netsuite-transaction-pdf-suitelet.js']) {
  cpSync(path,`${scratch}/${path}`,{recursive:true});
}
symlinkSync(process.cwd()+'/node_modules',`${scratch}/node_modules`);
mkdirSync(`${scratch}/test-artifacts/delivery-requests-ui`,{recursive:true});
const documents='test/mbt/unit/delivery-request-documents.test.js',pdf='test/mbt/unit/delivery-estb-pdf.test.js';
const browser='test/mbt/integration/delivery-request-enhancements-browser.test.js';
const mutations=[
  ['lose explicit zero PLT','src/delivery-request-documents.js','pallets:line.custcol_plt ?? null','pallets:line.custcol_plt || null',documents,false],
  ['swap LYR with SEC','src/delivery-request-documents.js','layers:line.custcol_lyr ?? null','layers:line.custcol_sec ?? null',documents,true],
  ['wrong estimate PDF action','src/netsuite-order-pdf.js',"estimate: 'estimatePdf'","estimate: 'salesOrderPdf'",pdf,true],
  ['accept wrong PDF identity','src/netsuite-order-pdf.js',' || Number(payload.entityId) !== id','',pdf,false],
  ['render other record types through quote action','netsuite-smart-scm-picking-ticket-restlet.js',
    'if (visible.length !== 1 || Number(visible[0].id) !== entityId)','if (false)',pdf,false],
  ['allow anonymous Suitelet users','netsuite-transaction-pdf-suitelet.js','if(!Number.isSafeInteger(userId) || userId<=0)','if(false)',pdf,false],
  ['bypass Suitelet type and visibility','netsuite-transaction-pdf-suitelet.js','if(visible.length!==1 || Number(visible[0].id)!==entityId)','if(false)',pdf,false],
  ['display zero packing as missing','public/delivery-requests.js',"line[key] ?? '—'","line[key] || '—'",browser,false]
];
const results=[];
function run(suite,pattern='') {
  const result=spawnSync(process.execPath,['--test','--test-concurrency=1',...(pattern?[`--test-name-pattern=${pattern}`]:[]),suite],{
    cwd:scratch,encoding:'utf8',timeout:60000,maxBuffer:8*1024*1024,
    env:{...process.env,NODE_V8_COVERAGE:'',DELIVERY_UI_COVERAGE:'0'}});
  const log=(result.stdout || '')+(result.stderr || '');
  return {killed:result.status!==0 && /not ok/u.test(log) && !/ERR_MODULE_NOT_FOUND|SyntaxError/u.test(log),log,status:result.status};
}
try {
  for(const [index,[name,file,from,to,suite,property]] of mutations.entries()) {
    const target=`${scratch}/${file}`,original=readFileSync(target,'utf8');
    assert.equal(original.split(from).length,2,`Unique mutation anchor: ${name}`);
    try {
      writeFileSync(target,original.replace(from,to));
      const result=run(suite);writeFileSync(`${output}/${index+1}.log`,result.log);
      const detail={name,killed:result.killed,exitCode:result.status,propertyOnly:null};
      if(property) {
        const checked=run(suite,'^property:');writeFileSync(`${output}/${index+1}-property.log`,checked.log);
        detail.propertyOnly={killed:checked.killed,exitCode:checked.status};
      }
      results.push(detail);process.stdout.write(`${name}: ${result.killed?'KILLED':'SURVIVED'}\n`);
    } finally {writeFileSync(target,original);}
  }
} finally {
  const hash=file=>createHash('sha256').update(readFileSync(file)).digest('hex');
  const restored=mutations.every(([,file])=>hash(file)===hash(`${scratch}/${file}`));
  writeFileSync(`${output}/results.json`,JSON.stringify({results,restored},null,2)+'\n');
  rmSync(scratch,{recursive:true,force:true});assert.equal(restored,true);
}
assert.equal(results.length,mutations.length);
assert.ok(results.every(result=>result.killed && (!result.propertyOnly || result.propertyOnly.killed)));
