import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { query, withTransaction, closeDb } from './src/db.js';
import { config } from './src/config.js';
import { DISPATCH_FLEET_PLANNING_LOCK } from './src/dispatch-fleet-status.js';
import { executeScmDependencyCommand, scmDependencyPayloadHash } from './src/scm-dependency-command-service.js';
import { previewScmDependencyMutation } from './src/scm-dependency-preview-service.js';
config.netsuite.directAccessEnabled=false;
const apply=process.env.SOM06964_UNLINK_APPLY==='1';
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const snapshot=async()=>({
  headers:(await query("SELECT * FROM sales_orders WHERE tranid ~ '^SOM06964(-S[0-9]+)*$' ORDER BY netsuite_id")).rows,
  lines:(await query("SELECT l.* FROM sales_order_lines l JOIN sales_orders s ON s.netsuite_id=l.sales_order_id WHERE s.tranid ~ '^SOM06964(-S[0-9]+)*$' ORDER BY l.id")).rows
});
try {
 const result=await withTransaction(async()=>{
  if(!apply) await query('SET TRANSACTION READ ONLY');
  else {
   await query("SET LOCAL lock_timeout='5s'");
   await query("SET LOCAL statement_timeout='60s'");
   await query('SELECT pg_advisory_xact_lock(hashtext($1))',[DISPATCH_FLEET_PLANNING_LOCK]);
  }
  const actorRow=(await query("SELECT id,username,active,role,roles FROM operators WHERE lower(username)='testadmin'")).rows[0];
  assert.ok(actorRow?.active && [actorRow.role,...actorRow.roles].includes('admin'));
  const actor={id:actorRow.id,sessionId:'codex:SOM06964:unsplit:20261015',surface:'dispatch'};
  const before=await snapshot();
  const links=(await query("SELECT * FROM dispatch_so_po_allocations WHERE status='active' AND (sales_order_ref ~ '^SOM06964(-S[0-9]+)*$' OR dispatch_target_ref ~ '^SOM06964(-S[0-9]+)*$') ORDER BY id")).rows;
  assert.ok(links.length===0 || JSON.stringify(links.map(row=>Number(row.id)))===JSON.stringify([268,269,270,271,272]),'Allocations changed; re-inspect');
  const results=[];
  for(const link of links){
   const command={requestId:`6f3081e1-4162-4d81-8e64-${String(link.id).padStart(12,'0')}`,
    action:'unlink_po',targetRef:link.dispatch_target_ref || link.sales_order_ref,payload:{allocationId:Number(link.id)}};
   command.payloadHash=scmDependencyPayloadHash(command);
   const preview=await previewScmDependencyMutation(command,actor);
   assert.equal(preview.allowed,true,JSON.stringify(preview.blockers));
   assert.equal(preview.affectedPlan,null,'An active route now requires a separately reviewed update');
   if(apply){
    const response=await executeScmDependencyCommand(command,actor);
    assert.equal(response.status,'applied');
    results.push({allocationId:Number(link.id),poRef:link.po_order_ref,requestId:command.requestId,status:response.cancelled.status});
   } else results.push({allocationId:Number(link.id),allowed:true});
  }
  const remaining=(await query("SELECT id FROM dispatch_so_po_allocations WHERE status='active' AND (sales_order_ref ~ '^SOM06964(-S[0-9]+)*$' OR dispatch_target_ref ~ '^SOM06964(-S[0-9]+)*$')")).rows;
  if(apply) assert.equal(remaining.length,0);
  assert.equal(hash(before),hash(await snapshot()),'Canonical sales headers/lines changed');
  return {at:new Date().toISOString(),applied:apply,actor:actorRow.username,results,remainingActivePoAllocations:remaining.length,canonicalSalesDataUnchanged:true};
 });
 console.log(JSON.stringify(result,null,2));
} finally {await closeDb();}
