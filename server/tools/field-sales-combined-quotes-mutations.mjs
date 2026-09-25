import {cpSync,readFileSync,writeFileSync,mkdtempSync,symlinkSync,rmSync,mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import assert from 'node:assert/strict';
const cases=[
 {name:'Drop all but the first item',file:'src/field-sales/company-quotes.js',from:'const calculated=calculateQuote(p,settings.companies);',to:'const calculated=calculateQuote({...p,lines:p.lines.slice(0,1)},settings.companies);',tests:['combined-quotes']},
 {name:'Leak other company lines into orders',file:'src/field-sales/company-quotes.js',from:'const lines=s.lines.filter(l=>l.company===company);',to:'const lines=s.lines;',tests:['combined-quotes']},
 {name:'Allow edits after confirmation',file:'src/field-sales/company-quotes.js',from:'if(existing?.confirmation){',to:'if(existing?.confirmation&&false){',tests:['combined-quotes']},
 {name:'Emit only the first company PDF section',file:'src/field-sales/company-pdf.js',from:'selected.map(c=>renderCompany',to:'selected.slice(0,1).map(c=>renderCompany',tests:['combined-quotes']},
 {name:'Merge a subsequently edited batch',file:'migrations/214_field_sales_combined_quotes.sql',from:"q.revision=(p->>'revision')::integer",to:'true',tests:['combined-quotes']}
];
const dir=process.env.FIELD_SALES_ARTIFACT_DIR||'test-artifacts/field-sales/combined-quotes',results=[];mkdirSync(dir,{recursive:true});
for(const m of cases){
 const root=mkdtempSync(join(tmpdir(),'field-sales-mutant-'));
 try{
  for(const name of ['src','public','test/field-sales','migrations']){cpSync(resolve(name),join(root,name),{recursive:true});}
  cpSync('package.json',join(root,'package.json'));cpSync('netsuite-field-sales-restlet.js',join(root,'netsuite-field-sales-restlet.js'));symlinkSync(resolve('node_modules'),join(root,'node_modules'),'dir');
  const file=join(root,m.file),source=readFileSync(file,'utf8');assert.equal(source.split(m.from).length,2,m.name+' unique mutation');writeFileSync(file,source.replace(m.from,m.to));
  const run=(tests,propertyOnly=false)=>spawnSync(process.execPath,['--test','--test-concurrency=1',...(propertyOnly?['--test-name-pattern=Mixed quote conservation property']:[]),...tests.map(t=>'test/field-sales/'+t+'.test.js')],{cwd:root,env:{...process.env,FIELD_SALES_ARTIFACT_DIR:''},encoding:'utf8',timeout:60000,maxBuffer:8*1024*1024});
  const suite=run(m.tests),property=run(['combined-quotes'],true);
  const killed=suite.status!==0&&suite.stdout.includes('not ok')&&!/ERR_MODULE_NOT_FOUND|SyntaxError/.test(suite.stderr);
  const propertyKilled=property.status!==0&&property.stdout.includes('not ok');
  results.push({name:m.name,killed,propertyKilled});writeFileSync(join(dir,'mutant-'+results.length+'.log'),suite.stdout+suite.stderr+'\nPROPERTY-ONLY\n'+property.stdout+property.stderr);assert.equal(killed,true,m.name+' must be killed');
 }finally{rmSync(root,{recursive:true,force:true});}
}
const report={passed:results.every(r=>r.killed),killed:results.filter(r=>r.killed).length,total:results.length,propertyKilled:results.filter(r=>r.propertyKilled).length,results};
writeFileSync(join(dir,'mutations.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
