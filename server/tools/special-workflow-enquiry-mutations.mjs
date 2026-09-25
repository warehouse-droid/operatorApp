import {cp,mkdir,readFile,writeFile,rm,symlink} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import path from 'node:path';
if(process.env.MBT_TEST_ISOLATED!=='1' || !process.env.DATABASE_URL?.endsWith('/mbt_verify'))throw new Error('Isolated verification database required');
const root='/tmp/special-workflow-enquiry-mutants';await rm(root,{recursive:true,force:true});await mkdir(root,{recursive:true});
for(const dir of ['src','public','test','migrations'])await cp(dir,path.join(root,dir),{recursive:true});
await cp('package.json',path.join(root,'package.json'));await symlink('/app/node_modules',path.join(root,'node_modules'));
const tests=['test/mbt/unit/special-workflow-enquiry.test.js','test/mbt/integration/special-workflow-enquiry.test.js'];
const run=(args,options={})=>spawnSync(process.execPath,args,{cwd:root,encoding:'utf8',timeout:120000,maxBuffer:10*1024*1024,...options});
const baseline=run(['--test','--test-concurrency=1',...tests]);if(baseline.status!==0)throw new Error(baseline.stdout+baseline.stderr);
const mutants=[
 ['MBBS directory omitted','src/special-stock-customer-directory.js','WHERE NOT EXISTS(SELECT 1','WHERE false AND NOT EXISTS(SELECT 1'],
 ['inactive customers included','src/special-stock-customer-directory.js','WHERE active=true','WHERE true'],
 ['enquiry minimum shifted','src/special-stock-request-domain.js','return torontoCalendarDate(now);','return torontoCalendarDate(new Date(new Date(now).getTime()+86400000));'],
 ['directory SO identity lost','src/special-stock-request-repository.js','customerId: numberOrNull(row.canonical_customer_id ?? row.directory_customer_id),','customerId: numberOrNull(row.canonical_customer_id),']
];
let killed=0,propertyKilled=0;
for(const[name,file,from,to]of mutants){
 const target=path.join(root,file),source=await readFile(target,'utf8');if(source.split(from).length!==2)throw new Error('Non-unique mutation '+name);
 try{
  await writeFile(target,source.replace(from,to));const result=run(['--test','--test-concurrency=1',...tests]);
  if(result.status!==1 || !result.stdout.includes('not ok') || /SyntaxError|ERR_MODULE_NOT_FOUND/.test(result.stdout+result.stderr))throw new Error('Invalid/surviving mutation '+name+result.stdout+result.stderr);
  killed++;console.log('KILLED: '+name);
  const property=run(['--test','--test-name-pattern=property:',...tests]);if(![0,1].includes(property.status))throw new Error('Invalid property run');
  propertyKilled+=property.status===1?1:0;console.log(`PROPERTY-ONLY ${property.status===1?'KILLED':'SURVIVED'}: ${name}`);
 }finally{await writeFile(target,source);}
}
const restored=run(['--test','--test-concurrency=1',...tests]);if(restored.status!==0)throw new Error(restored.stdout+restored.stderr);
for(const[name,from,to,filter]of [
 ['dirty state forgotten','state.soDraftDirty = true;','state.soDraftDirty = false;','dirty-ancillary-add'],
 ['default conversion doubled','conversionToPc: line.conversionToPc ?? 1','conversionToPc: line.conversionToPc ?? 2','fixed-unit-default']
]){
 const result=run(['tools/special-workflow-enquiry-browser.mjs'],{cwd:process.cwd(),env:{...process.env,PLAYWRIGHT_BROWSERS_PATH:'/browsers',SPECIAL_POLISH_BROWSER_OUTPUT:'test-artifacts/special-workflow-enquiry/browser-mutants/'+filter,SPECIAL_POLISH_BROWSER_FILTER:filter,SPECIAL_POLISH_BROWSER_MUTATION:JSON.stringify(['public/sales-special-stock-requests.js',from,to])}});
 if(result.status!==1 || !result.stdout.includes('FAIL'))throw new Error('Invalid/surviving browser mutation '+name+result.stdout+result.stderr);
 killed++;console.log('KILLED (browser): '+name);
}
console.log(`Enquiry manual faults: ${killed}/6 killed; property-only backend: ${propertyKilled}/4 killed; DOM mutations are outside the property suite.`);
