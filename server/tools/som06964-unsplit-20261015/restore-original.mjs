// Repair this known split's lost descriptive piece counts, then use normal Unsplit.
// The canonical parent is never edited. All work is one audited transaction.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { query, withTransaction, closeDb } from './src/db.js';
import { config } from './src/config.js';
import { DISPATCH_FLEET_PLANNING_LOCK } from './src/dispatch-fleet-status.js';
import { lockConsolidatedLoadOrders } from './src/consolidation-load-locks.js';
import { unsplitSalesOrder } from './src/dispatch-sales-resplit-repository.js';
import { writeDispatchAudit } from './src/dispatch-audit-repository.js';
import { listDispatchOrders } from './src/dispatch-repository.js';
import { overlayFulfilledSalesDeliveryPlanning } from './src/dispatch-fulfilled-so-repository.js';
import { upsertDispatchOrderCatalog } from './src/dispatch-order-catalog-repository.js';
import { listDeliveryOrders } from './src/delivery-repository.js';
config.netsuite.directAccessEnabled=false;
const apply=process.env.SOM06964_RESTORE_APPLY==='1';
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const refs=['SOM06964','SOM06964-S1','SOM06964-S2'];
const quantities=[['quantity','quantity'],['pallets','pallet_qty'],['layers','layer_qty'],['sections','section_qty'],['pieces','piece_qty']];
try {
 const result=await withTransaction(async()=>{
  if(!apply) await query('SET TRANSACTION READ ONLY');
  else {
   await query("SET LOCAL lock_timeout='5s'");
   await query("SET LOCAL statement_timeout='90s'");
   await query('SELECT pg_advisory_xact_lock(hashtext($1))',[DISPATCH_FLEET_PLANNING_LOCK]);
  }
  const actor=(await query("SELECT id,username,active,role,roles FROM operators WHERE lower(username)='testadmin'")).rows[0];
  assert.ok(actor?.active && [actor.role,...actor.roles].includes('admin'));
  const lock=apply?' FOR UPDATE':'';
  const identities=(await query('SELECT netsuite_id FROM sales_orders WHERE tranid=ANY($1::text[]) ORDER BY netsuite_id',[refs])).rows;
  if(apply) await lockConsolidatedLoadOrders(identities.map(row=>row.netsuite_id));
  const headers=(await query('SELECT * FROM sales_orders WHERE tranid=ANY($1::text[]) ORDER BY netsuite_id'+lock,[refs])).rows;
  assert.equal(headers.length,3);
  const lines=(await query('SELECT * FROM sales_order_lines WHERE sales_order_id=ANY($1::bigint[]) ORDER BY id'+lock,[headers.map(row=>row.netsuite_id)])).rows;
  const definitions=(await query("SELECT * FROM dispatch_global_order_splits WHERE parent_order_ref='SOM06964' AND active ORDER BY split_ref"+lock)).rows;
  assert.deepEqual(definitions.map(row=>row.split_ref),refs.slice(1));
  const parent=headers.find(row=>row.tranid==='SOM06964');
  assert.equal(String(parent.netsuite_id),'1049213');
  assert.equal(parent.operator_status,'open');
  const parentLines=lines.filter(line=>String(line.sales_order_id)==='1049213');
  const beforeHash=hash({parent,parentLines});
  assert.equal((await query("SELECT 1 FROM dispatch_so_po_allocations WHERE status='active' AND (sales_order_ref=ANY($1::text[]) OR dispatch_target_ref=ANY($1::text[]))",[refs])).rowCount,0);
  assert.equal((await query("SELECT 1 FROM order_dependencies WHERE status='active' AND (sales_order_ref=ANY($1::text[]) OR dispatch_target_ref=ANY($1::text[]))",[refs])).rowCount,0);
  const repairs=[];
  for(const original of parentLines){
   const parts=definitions.flatMap(definition=>definition.full_order.items.filter(item=>String(item.lineId)===String(original.line_id)).map(item=>({definition,item})));
   for(const [field,native] of quantities){
    const expected=Number(original[native]||0),actual=parts.reduce((sum,part)=>sum+Number(part.item[field]||0),0);
    if(Math.abs(expected-actual)<1e-6) continue;
    assert.equal(field,'pieces','Only the observed descriptive-piece defect is permitted');
    assert.equal(original.item_type,'NonInvtPart');
    assert.ok(['to_plt','to_lyr','to_sec','to_pcs'].every(key=>Number(original[key]||0)===0));
    assert.equal(actual,0);assert.ok(expected>0);assert.equal(parts.length,1);
    const {definition,item}=parts[0];
    assert.equal(Number(item.quantity),Number(original.quantity),'A repair needs the complete original sales quantity in one child');
    const child=headers.find(row=>row.tranid===definition.split_ref);
    const nativeLines=lines.filter(line=>String(line.sales_order_id)===String(child.netsuite_id) && String(line.line_id)===String(original.line_id));
    assert.equal(nativeLines.length,1);
    assert.equal(Number(nativeLines[0].piece_qty||0),0);
    assert.equal(Number(nativeLines[0].quantity),Number(original.quantity));
    repairs.push({ref:definition.split_ref,lineId:String(original.line_id),nativeLineId:nativeLines[0].id,pieces:expected});
   }
  }
  assert.deepEqual(repairs.map(row=>row.lineId).sort(),['5105105','5105108','5105110','5105112']);
  const sessionId='codex:SOM06964:unsplit:20261015';
  let unsplit;
  if(apply){
   for(const repair of repairs){
    await query('UPDATE sales_order_lines SET piece_qty=$2 WHERE id=$1',[repair.nativeLineId,repair.pieces]);
    const definition=definitions.find(row=>row.split_ref===repair.ref);
    definition.full_order.items.find(item=>String(item.lineId)===repair.lineId).pieces=repair.pieces;
   }
   for(const definition of definitions) await query('UPDATE dispatch_global_order_splits SET full_order=$2::jsonb,updated_at=now() WHERE split_ref=$1',
    [definition.split_ref,JSON.stringify(definition.full_order)]);
   await writeDispatchAudit({action:'order_unsplit_metadata_repair',entityType:'order',entityId:'SOM06964',orderId:'SOM06964',
    operatorId:actor.id,sessionId,before:{headers,lines},details:{reason:'User requested restore of original SOM06964. Reconstruct lost descriptive pieces from intact parent, only where one unstarted child contains the entire sales line.',repairs}});
   unsplit=await unsplitSalesOrder({orderRef:'SOM06964-S1',orderType:'SO',planId:'359',planDate:'2026-10-15',actor,sessionId});
   assert.deepEqual(unsplit.deactivated.sort(),refs.slice(1));
   const afterParent=(await query('SELECT * FROM sales_orders WHERE netsuite_id=1049213')).rows[0];
   const afterLines=(await query('SELECT * FROM sales_order_lines WHERE sales_order_id=1049213 ORDER BY id')).rows;
   assert.equal(hash({parent:afterParent,parentLines:afterLines}),beforeHash,'Original sales order changed');
   assert.equal((await query("SELECT 1 FROM sales_orders WHERE tranid=ANY($1::text[]) AND netsuite_active",[refs.slice(1)])).rowCount,0);
   assert.equal((await query("SELECT 1 FROM dispatch_global_order_splits WHERE parent_order_ref='SOM06964' AND active")).rowCount,0);
   const fresh=await overlayFulfilledSalesDeliveryPlanning(await listDispatchOrders({type:'SO',search:'SOM06964'}));
   const restored=fresh.find(row=>row.id==='SOM06964');
   assert.ok(restored?.localOrderReopened);
   assert.equal(restored.dispatchFulfilledSalesPlanningEligible,true);
   assert.equal(restored.dispatchPlanningRestricted,false);
   await upsertDispatchOrderCatalog({orders:[restored],source:'user-requested-som06964-unsplit'});
   const active=await listDeliveryOrders({locationId:26,status:'active',orderType:'sales_order',allowedOperatorYards:[26]});
   assert.ok(active.some(row=>row.tranid==='SOM06964'));
   assert.equal(active.some(row=>refs.slice(1).includes(row.tranid)),false);
  }
  return {at:new Date().toISOString(),applied:apply,actor:actor.username,repairs,
   restoredOrderRef:apply?'SOM06964':null,deactivated:unsplit?.deactivated || [],canonicalParentUnchanged:true,
   remainingActivePoAllocations:0,remainingActiveToDependencies:0,locallyOpen:apply,operatorVisible:apply};
 });
 console.log(JSON.stringify(result,null,2));
} finally {await closeDb();}
