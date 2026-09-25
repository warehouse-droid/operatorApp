import {cpSync,readFileSync,writeFileSync,mkdtempSync,symlinkSync,rmSync,mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import assert from 'node:assert/strict';
const cases=[
 {name:'Accept a missing customer link',file:'src/field-sales/customers.js',from:'if(!id){throw fail(`Link an existing',to:'if(false){throw fail(`Link an existing',tests:['existing-customers']},
 {name:'Ignore a stale reviewed customer',file:'src/field-sales/customers.js',from:'checkRevision(row,{revision});',to:'void revision;',tests:['existing-customers']},
 {name:'Replace lookup with customer creation',file:'src/field-sales/orders.js',from:"const remote=await transport('customer.lookup',p);",to:"const remote=await transport('customer.ensure',p);",tests:['existing-customers']},
 {name:'Restore the direct customer creation action',file:'netsuite-field-sales-restlet.js',from:"if(request.action==='customer.ensure'){failure('Customer creation is disabled. Customers and subsidiary memberships must be created in NetSuite.');}",to:"if(request.action==='customer.ensure'){return {ok:true,internalId:record.create({type:record.Type.CUSTOMER,isDynamic:false}).save()};}",tests:['existing-customer-restlet']},
 {name:'Skip a required subsidiary membership',file:'netsuite-field-sales-restlet.js',from:'c.customerSubsidiaries.some(id=>!customer.subsidiaries.includes(String(id)))',to:'false',tests:['existing-customer-restlet']},
 {name:'Accept a changed persisted order customer',file:'src/field-sales/orders.js',from:'if(p.linkedCustomerId&&p.customerNetsuiteId&&p.linkedCustomerId!==p.customerNetsuiteId)',to:'if(false)',tests:['existing-customers']}
];
const dir=process.env.FIELD_SALES_ARTIFACT_DIR||'test-artifacts/field-sales/existing-customers',results=[];mkdirSync(dir,{recursive:true});
for(const m of cases){
 const root=mkdtempSync(join(tmpdir(),'field-sales-mutant-'));
 try{
  for(const name of ['src','public','test/field-sales','migrations']){cpSync(resolve(name),join(root,name),{recursive:true});}
  cpSync('package.json',join(root,'package.json'));cpSync('netsuite-field-sales-restlet.js',join(root,'netsuite-field-sales-restlet.js'));symlinkSync(resolve('node_modules'),join(root,'node_modules'),'dir');
  const file=join(root,m.file),source=readFileSync(file,'utf8');assert.equal(source.split(m.from).length,2,m.name+' unique mutation');writeFileSync(file,source.replace(m.from,m.to));
  const run=(tests,propertyOnly=false)=>spawnSync(process.execPath,['--test','--test-concurrency=1',...(propertyOnly?['--test-name-pattern=property']:[]),...tests.map(t=>'test/field-sales/'+t+'.test.js')],{cwd:root,env:{...process.env,FIELD_SALES_ARTIFACT_DIR:''},encoding:'utf8',timeout:60000,maxBuffer:8*1024*1024});
  const suite=run(m.tests),property=run(['existing-customers','existing-customer-restlet'],true);
  const killed=suite.status!==0&&suite.stdout.includes('not ok')&&!/ERR_MODULE_NOT_FOUND|SyntaxError/.test(suite.stderr);
  const propertyKilled=property.status!==0&&property.stdout.includes('not ok');
  results.push({name:m.name,killed,propertyKilled});writeFileSync(join(dir,'mutant-'+results.length+'.log'),suite.stdout+suite.stderr+'\nPROPERTY-ONLY\n'+property.stdout+property.stderr);assert.equal(killed,true,m.name+' must be killed');
 }finally{rmSync(root,{recursive:true,force:true});}
}
const report={passed:results.every(r=>r.killed),killed:results.filter(r=>r.killed).length,total:results.length,propertyKilled:results.filter(r=>r.propertyKilled).length,results};
writeFileSync(join(dir,'mutations.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
