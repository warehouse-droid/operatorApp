import assert from "node:assert/strict";
import test, { before, after } from "node:test";
import { app } from "../../../src/server.js";
import { query, closeDb } from "../../../src/db.js";
import { createOperator, loginOperator } from "../../../src/auth-repository.js";

let server, baseUrl, scmToken, dispatcherToken, operatorId;
const nonce=Date.now();
const ref=`PO-VENDOR-HTTP-${nonce}`;
let revision;
before(async()=>{
  assert.equal(process.env.MBT_TEST_ISOLATED,"1");
  for(const role of ["scm","dispatcher"]){
    const username=`vendor_http_${role}_${nonce}`;
    const operator=await createOperator({username,displayName:username,password:"TestLocalFixture123!",role});
    const login=await loginOperator(username,"TestLocalFixture123!");
    if(role==="scm"){scmToken=login.token;operatorId=operator.id;}else {dispatcherToken=login.token;}
  }
  await query(`INSERT INTO purchase_orders (netsuite_id,tranid,status,status_text,initial_scm_status,netsuite_active)
    VALUES ($1,$2,'B','Purchase Order : Pending Receipt','Queued',true)`,[nonce,ref]);
  const result=await query(`INSERT INTO scm_transport_schedule (order_kind,order_ref,method,status)
    VALUES ('PO',$1,'Vendor','Queued') RETURNING updated_at::text AS revision`,[ref]);
  revision=result.rows[0].revision;
  server=app.listen(0,"127.0.0.1");await new Promise(resolve=>server.once("listening",resolve));
  baseUrl=`http://127.0.0.1:${server.address().port}`;
});
after(async()=>{await new Promise(resolve=>server?.close(resolve));await closeDb();});
async function complete(token,body={}){
  const response=await fetch(`${baseUrl}/api/scm/schedule/${ref}/complete-vendor`,{
    method:"POST",headers:{"content-type":"application/json",...(token?{authorization:`Bearer ${token}`}:{})},
    body:JSON.stringify({orderKind:"PO",expectedUpdatedAt:revision,...body})
  });
  return {status:response.status,body:await response.json()};
}
test("endpoint denies unauthenticated and forged-role requests",async()=>{
  assert.equal((await complete("")).status,401);
  assert.equal((await complete(dispatcherToken,{actor:{id:operatorId,role:"admin"},method:"Vendor"})).status,403);
  assert.equal((await complete(scmToken,{expectedUpdatedAt:"2000-01-01T00:00:00Z"})).status,409);
  assert.equal((await query("SELECT count(*)::int AS count FROM dispatch_order_completion_events WHERE order_ref=$1",[ref])).rows[0].count,0);
});
test("12 concurrent authorized clicks produce one audited local completion",async()=>{
  const beforeState=await query(`SELECT (SELECT count(*) FROM driver_job_records)::int AS jobs,
    (SELECT count(*) FROM dispatch_sales_order_if_candidates)::int AS outbox,
    (SELECT count(*) FROM dispatch_plans)::int AS plans`);
  const results=await Promise.all(Array.from({length:12},()=>complete(scmToken,{actor:{id:"forged-actor",role:"admin"}})));
  assert.ok(results.every(result=>result.status===200),JSON.stringify(results));
  assert.equal(results.filter(result=>result.body.result.idempotent===false).length,1);
  assert.equal(new Set(results.map(result=>result.body.result.completionEventId)).size,1);
  const {rows}=await query("SELECT actor_id,completion_evidence_type FROM dispatch_order_completion_events WHERE order_ref=$1",[ref]);
  assert.equal(rows.length,1);assert.equal(rows[0].actor_id,operatorId);assert.equal(rows[0].completion_evidence_type,"scm_vendor");
  const afterState=await query(`SELECT (SELECT count(*) FROM driver_job_records)::int AS jobs,
    (SELECT count(*) FROM dispatch_sales_order_if_candidates)::int AS outbox,
    (SELECT count(*) FROM dispatch_plans)::int AS plans`);
  assert.deepEqual(afterState.rows,beforeState.rows);
  const response=await fetch(`${baseUrl}/api/scm/schedule?search=${ref}&view=scm%20working`,{headers:{authorization:`Bearer ${scmToken}`}});
  assert.equal(response.status,200);
  const schedule=await response.json();
  assert.equal(schedule.length,1);assert.equal(schedule[0].calculatedStatus,"Completed");
  assert.equal(schedule[0].dispatchCompletionEvidenceType,"scm_vendor");
});
