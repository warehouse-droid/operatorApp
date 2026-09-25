// Execute through stdin in the app container; no NetSuite transport is imported.
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {query,withTransaction,closeDb} from './src/db.js';
const action=process.env.FIELD_SALES_SETTINGS_ACTION||'verify',path=process.env.FIELD_SALES_SETTINGS_BACKUP;
const actor='system:authorized-existing-customers-20260922';
assert.ok(path,'Set a private backup path');
const current=async()=>(await query('SELECT * FROM field_sales_settings WHERE singleton')).rows[0];
function withoutCreation(data){const next=structuredClone(data);for(const c of Object.values(next.companies)){delete c.customerFormId;delete c.customerStatusId;}return next;}
async function update(state,{rollback=false,restore=false}={}){
 return withTransaction(async()=>{
  const row=(await query('SELECT * FROM field_sales_settings WHERE singleton FOR UPDATE')).rows[0];
  assert.equal(row.revision,state.before.revision+(restore?1:0));assert.deepEqual(row.data,restore?state.after:state.before.data);
  const data=restore?state.before.data:state.after;
  await query('UPDATE field_sales_settings SET data=$1,revision=revision+1,updated_at=now(),updated_by=$2 WHERE singleton',[JSON.stringify(data),actor]);
  await query('INSERT INTO field_sales_audit(actor_id,action,target_id,detail) VALUES($1,$2,$3,$4)',[actor,restore?'settings.rollback':'settings.update','settings',JSON.stringify({reason:'Customers are created in NetSuite; retire customer creation configuration',fields:['customerFormId','customerStatusId'],previousRevision:row.revision})]);
  const result=await current();assert.deepEqual(result.data,data);return result;
 },{rollback});
}
try{
 assert.notEqual(process.env.FIELD_SALES_NETSUITE_WRITES_ENABLED,'true');
 if(action==='prepare'){
  const before=await current();const state={before,after:withoutCreation(before.data),preparedAt:new Date().toISOString()};
  await writeFile(path,JSON.stringify(state,null,2),{mode:0o600,flag:'wx'});console.log(JSON.stringify({prepared:true,revision:before.revision,fieldsRemoved:['customerFormId','customerStatusId']}));
 }else{
  const state=JSON.parse(await readFile(path,'utf8'));
  if(action==='rehearse'){
   const before=await current(),count=(await query('SELECT count(*)::int n FROM field_sales_audit WHERE actor_id=$1',[actor])).rows;
   await update(state,{rollback:true});assert.deepEqual(await current(),before);assert.deepEqual((await query('SELECT count(*)::int n FROM field_sales_audit WHERE actor_id=$1',[actor])).rows,count);
   console.log(JSON.stringify({rehearsalPassed:true,settingsAndAuditRestored:true}));
  }else if(action==='apply'||action==='rollback'){
   const result=await update(state,{restore:action==='rollback'});console.log(JSON.stringify({[action]:true,revision:result.revision}));
  }else if(action==='verify'){
   const result=await current();assert.deepEqual(result.data,state.after);assert.equal(result.revision,state.before.revision+1);
   console.log(JSON.stringify({passed:true,revision:result.revision,customerCreationFieldsRemoved:true,otherSettingsPreserved:true,mbbsLocationId:result.data.companies.MBBS.locationId,postingGate:false}));
  }else{throw Error('Unknown settings action');}
 }
}finally{await closeDb();}
