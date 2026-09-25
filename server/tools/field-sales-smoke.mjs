import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { app } from '../src/server.js';
import { createOperator,loginOperator } from '../src/auth-repository.js';
import { query,closeDb } from '../src/db.js';
if(process.env.MBT_TEST_ISOLATED!=='1'){throw new Error('Disposable database required.');}
const original=(await query('SELECT * FROM field_sales_settings')).rows[0];
const server=await new Promise(resolve=>{const instance=app.listen(0,'127.0.0.1',()=>resolve(instance));});
try{
  await query(`UPDATE field_sales_settings SET data=jsonb_set(data,'{enabled}','true')`);
  const base=`http://127.0.0.1:${server.address().port}`;
  for(const page of ['/field-sales/','/driver','/sales','/mbt','/operator']){const response=await fetch(base+page);assert.equal(response.status,200,page);assert.match(response.headers.get('content-type'),/html/);}
  assert.equal((await fetch(base+'/api/field-sales/jobsites')).status,401);
  for(const role of ['field_sales','admin','sales']){
    const username=`fs-smoke-${randomUUID()}`,password=randomUUID();await createOperator({username,password,displayName:'Smoke test',role});
    const login=await loginOperator(username,password);const response=await fetch(base+'/api/field-sales/status',{headers:{Authorization:`Bearer ${login.token}`}});assert.equal(response.status,role==='sales'?403:200);
    if(role==='field_sales'){assert.equal(login.operator.homeRoute,'/field-sales/');}
  }
  console.log(JSON.stringify({passed:true,entrypoints:5,authenticatedRoleChecks:3,server:'Actual exported application, real PostgreSQL; workers tested separately'}));
}finally{await new Promise(resolve=>server.close(resolve));await query('UPDATE field_sales_settings SET data=$1,revision=$2 WHERE singleton',[original.data,original.revision]);await closeDb();}
process.exit(0);
