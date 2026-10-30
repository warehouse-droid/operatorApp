// User-authorized local data repair. Default: read-only preview. No remote calls.
// Run from /app via stdin with --apply and MBBS_REPAIR_EXPECTED from a saved preview.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { query, withTransaction, closeDb } from '/app/src/db.js';
import { DISPATCH_FLEET_PLANNING_LOCK } from '/app/src/dispatch-fleet-status.js';
import { lockConsolidatedLoadOrders } from '/app/src/consolidation-load-locks.js';
import { materializeSalesSplitOrder, getDeliveryOrder } from '/app/src/delivery-repository.js';
import { aggregateGlobalGroup, syncDispatchGlobalOrderSplitsFromPlan } from '/app/src/dispatch-delivery-group-repository.js';
import { compactDispatchOrderCard, dispatchOrderSearchText } from '/app/src/dispatch-planner-optimization.js';
import { digestDispatchPlan, dispatchPlanBoard } from '/app/src/dispatch-planner-performance.js';
import { syncDispatchPlanOrderAssignments, syncDispatchPlanRelationEdges } from '/app/src/dispatch-planner-v2-repository.js';
import { assertSplitLineQuantities } from '/app/src/dispatch-split-quantity-domain.js';
import { getDispatchOrderCatalogOrder, listDispatchOrderPool } from '/app/src/dispatch-order-catalog-repository.js';
import { packedInventorySnapshot } from '/app/src/inventory-packed-stock.js';
import { writeDispatchAudit } from '/app/src/dispatch-audit-repository.js';

const KEY='soa09623-09624-split-20261021';
const OLD='GOA-9623-9624', NEW='GOA-9623S1-9624S1';
const PARENTS=['SOA09623','SOA09624'], IDS=['1032654','1032665'];
const SPLITS=PARENTS.flatMap(ref=>[ref+'-S1',ref+'-S2']);
const LOAD='T5-L1792620379712-56bcc00752877';
const APPLY=process.argv.includes('--apply');
const round=n=>Number(Number(n).toFixed(6));
const plain=v=>JSON.parse(JSON.stringify(v));
const fingerprint=v=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
const rows=async(sql,args=[]) => (await query(sql,args)).rows;
const packFields=['packed_pallet_qty','packed_layer_qty','packed_section_qty','packed_piece_qty','packed_sales_qty'];

async function readState(lock=false) {
  const suffix=lock?' FOR UPDATE':'';
  const state={};
  state.headers=await rows('SELECT * FROM sales_orders WHERE netsuite_id=ANY($1::bigint[]) ORDER BY netsuite_id'+suffix,[IDS]);
  state.lines=await rows('SELECT * FROM sales_order_lines WHERE sales_order_id=ANY($1::bigint[]) ORDER BY id'+suffix,[IDS]);
  state.global=(await rows('SELECT * FROM dispatch_global_order_groups WHERE group_ref=$1'+suffix,[OLD]))[0];
  state.members=await rows('SELECT * FROM dispatch_global_order_group_members WHERE group_ref=$1 ORDER BY position'+suffix,[OLD]);
  state.delivery=(await rows('SELECT * FROM dispatch_delivery_groups WHERE group_ref=$1'+suffix,[OLD]))[0];
  state.deliveryMembers=await rows('SELECT * FROM dispatch_delivery_group_members WHERE group_ref=$1 ORDER BY position'+suffix,[OLD]);
  state.plan=(await rows(`SELECT p.*,p.plan_date::text AS "planDate",s.orders,s.trucks,s.summary,s.saved_at
    FROM dispatch_plans p JOIN dispatch_plan_snapshots s ON s.plan_id=p.id WHERE p.id=366${lock?' FOR UPDATE OF p,s':''}`))[0];
  state.loads=await rows('SELECT * FROM operator_load_records WHERE id IN(6052,6053) ORDER BY id'+suffix);
  state.assignments=await rows('SELECT * FROM dispatch_plan_order_assignments WHERE plan_id=366 ORDER BY order_ref');
  state.edges=await rows('SELECT * FROM dispatch_order_relation_edges WHERE plan_id=366 ORDER BY relation_type,owner_ref,member_ref');
  state.loadAssignments=await rows('SELECT * FROM dispatch_plan_load_assignments WHERE plan_id=366 ORDER BY load_id'+suffix);
  state.candidates=await rows('SELECT * FROM dispatch_sales_order_if_candidates WHERE source_sales_order_id=ANY($1::bigint[]) ORDER BY id'+suffix,[IDS]);
  state.claims=await rows('SELECT * FROM dispatch_sales_order_if_line_claims WHERE source_sales_order_id=ANY($1::bigint[]) ORDER BY candidate_id,source_line_id',[IDS]);
  state.protected=await protectedState();
  return plain(state);
}
async function protectedState() {
  return (await rows(`SELECT
    (SELECT md5(jsonb_agg(to_jsonb(o) ORDER BY netsuite_id)::text) FROM sales_orders o WHERE tranid IN('SOA09883','SOA09884')) headers,
    (SELECT md5(jsonb_agg(to_jsonb(l) ORDER BY id)::text) FROM sales_order_lines l WHERE sales_order_id IN(1044753,1044754)) lines,
    (SELECT md5(to_jsonb(g)::text) FROM dispatch_global_order_groups g WHERE group_ref='GOA-9883-9884') global_group,
    (SELECT md5(to_jsonb(g)::text) FROM dispatch_delivery_groups g WHERE group_ref='GOA-9883-9884') delivery_group,
    (SELECT md5(jsonb_agg(to_jsonb(l) ORDER BY id)::text) FROM operator_load_records l WHERE order_id IN(1044753,1044754)) loads,
    (SELECT md5(jsonb_agg(to_jsonb(c) ORDER BY id)::text) FROM dispatch_sales_order_if_candidates c WHERE source_sales_order_id IN(1032654,1032665,1044753,1044754)) candidates,
    (SELECT md5(jsonb_agg(to_jsonb(c) ORDER BY candidate_id,source_line_id)::text) FROM dispatch_sales_order_if_line_claims c WHERE source_sales_order_id IN(1032654,1032665,1044753,1044754)) claims
  `))[0];
}
async function guard(state) {
  assert.equal(state.plan.planDate,'2026-10-22');
  assert.equal(state.plan.status,'confirmed');
  assert.equal(state.global.active,true);assert.equal(state.delivery.active,true);
  assert.deepEqual(state.global.full_order.childOrders,PARENTS);
  assert.deepEqual(state.members.map(x=>x.member_order_ref),PARENTS);
  assert.deepEqual(state.deliveryMembers.map(x=>x.member_order_ref),PARENTS);
  assert.equal(state.plan.orders.filter(x=>x.id===OLD).length,1);
  assert.equal(state.headers.length,2);assert.equal(state.lines.length,9);
  const expected=[[497863,2762.1,1125.3,16,0],[497864,400,300,1,0],[497865,32.25,32.25,0,0],
    [497866,25.8,25.8,0,0],[497867,35,35,0,0],[497889,35,19,0,16],[497890,2,0,0,0],[497891,2,0,0,0],[552675,10,10,0,0]];
  assert.deepEqual(state.lines.map(l=>[Number(l.id),Number(l.quantity),Number(l.loaded_qty),Number(l.packed_pallet_qty||0),Number(l.packed_sales_qty||0)]),expected);
  assert.ok(state.lines.every(l=>l.netsuite_active && !l.sync_exception));
  assert.equal(state.loads.length,2);
  assert.deepEqual(state.loads.map(l=>l.order_ref),PARENTS);
  assert.equal(state.candidates.length,2);
  assert.deepEqual(state.candidates.map(c=>c.netsuite_transaction_ref).sort(),['IF159022','IF159023']);
  assert.ok(state.candidates.every(c=>c.status==='completed' && !c.lease_token));
  assert.ok(state.claims.every(c=>!c.active));
  const load=state.loadAssignments.find(l=>l.load_id===LOAD);
  assert.ok(load && !load.started && !load.completed);
  assert.equal(load.truck_plate,'CC46868');
  for(const [sql,args,label] of [
    ['SELECT 1 FROM sales_orders WHERE tranid=ANY($1)',[SPLITS],'split headers already exist'],
    ['SELECT 1 FROM dispatch_global_order_splits WHERE parent_order_ref=ANY($1)',[PARENTS],'split definitions already exist'],
    ['SELECT 1 FROM dispatch_scm_so_splits WHERE source_so_id=ANY($1::bigint[])',[IDS],'split ledger exists'],
    ['SELECT 1 FROM dispatch_global_order_groups WHERE group_ref=$1',[NEW],'new group exists'],
    ['SELECT 1 FROM dispatch_plan_edit_leases WHERE plan_date=$1::date AND expires_at>now()',[state.plan.planDate],'active dispatch editor'],
    ['SELECT 1 FROM driver_job_records WHERE plan_id=366 AND load_id=$1',[LOAD],'driver execution exists'],
    ["SELECT 1 FROM dispatch_so_po_allocations WHERE sales_order_id=ANY($1::bigint[]) AND status='active'",[IDS],'PO allocation exists'],
    ["SELECT 1 FROM order_dependencies WHERE sales_order_id=ANY($1::bigint[]) AND status<>'cancelled'",[IDS],'TO allocation exists'],
    ["SELECT 1 FROM operator_reload_cycles WHERE sales_order_id=ANY($1::bigint[])",[IDS],'reload exists'],
    ['SELECT 1 FROM operator_consolidation_orders WHERE order_ref=ANY($1)',[[...PARENTS,OLD]],'consolidation exists'],
    ["SELECT 1 FROM operator_netsuite_posting_order_claims WHERE active AND local_order_key=ANY($1)",[IDS.flatMap(id=>['delivery_prep:sales_order:'+id,'customer_pickup:sales_order:'+id])],'active posting exists']
  ])assert.equal((await rows(sql,args)).length,0,label);
}
function totals(order) {
  const units=new Map();
  for(const item of order.items) {const unit=item.unit||'Qty';units.set(unit,round((units.get(unit)||0)+item.quantity));}
  return {...order,salesQty:round(order.items.reduce((n,l)=>n+l.quantity,0)),salesQuantities:[...units].map(([unit,quantity])=>({unit,quantity})),
    pallets:order.items.reduce((n,l)=>n+l.pallets+(l.layers>0?1:0),0),layers:order.items.reduce((n,l)=>n+l.layers,0),
    sections:order.items.reduce((n,l)=>n+l.sections,0),pieces:order.items.reduce((n,l)=>n+l.pieces,0),
    weight:round(order.items.reduce((n,l)=>n+l.lineWeight,0)),itemCount:order.items.length};
}
function splitItem(item,line,part) {
  const loaded=Number(line.loaded_qty||0), quantity=part===1?loaded:round(Number(line.quantity)-loaded);
  // Fees are not loadable cargo: retain their full original quantity in S2.
  if(!quantity)return null;
  let counts={pallets:0,layers:0,sections:0,pieces:0};
  if(quantity===Number(line.quantity))counts={pallets:Number(line.pallet_qty||0),layers:Number(line.layer_qty||0),sections:Number(line.section_qty||0),pieces:Number(line.piece_qty||0)};
  else if(Number(line.to_plt)>0){assert.equal(round(quantity/Number(line.to_plt)),Math.round(quantity/Number(line.to_plt)));counts.pallets=Math.round(quantity/Number(line.to_plt));}
  return {...item,...counts,quantity,splitQty:quantity,splitUnit:counts.pallets?counts.pallets+' PLT':String(quantity)+' '+(item.unit||'Qty'),
    lineWeight:round(quantity*Number(item.itemWeight||0))};
}
function proposal(state) {
  const source=state.plan.orders.find(o=>o.id===OLD);
  const splits=[];
  for(const parent of state.headers) {
    const original=source.childOrderDetails.find(o=>o.id===parent.tranid);
    const lines=state.lines.filter(l=>l.sales_order_id===parent.netsuite_id);
    for(const part of [1,2]) {
      const id=parent.tranid+'-S'+part;
      const items=original.items.map(i=>splitItem(i,lines.find(l=>String(l.line_id)===String(i.lineId)),part)).filter(Boolean);
      const split=totals({...original,id,items,originalOrderId:parent.tranid,originalPallets:original.pallets,
        isSplit:true,childOrders:[],childOrderDetails:[],groupAliases:[],netsuiteId:'',planOwned:true,
        operatorStatus:part===1?'loaded':'packed',localYardOrderStatus:part===1?'Loaded':'Open',
        packed:part===1?{pallets:0,layers:0,sections:0,pieces:0}:{pallets:lines.reduce((n,l)=>n+Number(l.packed_pallet_qty||0),0),layers:0,sections:0,pieces:0},
        dispatchPlanned:part===1,plannedOrderRef:part===1?NEW:id,dispatchPlanId:part===1?'366':'',dispatchPlanDate:part===1?'2026-10-22':'',
        dispatchTruckPlate:part===1?'CC46868':'',dispatchLoadName:part===1?'Load 1':'',dispatchDriverName:part===1?'Li':'',dispatchDriverLogin:part===1?'li':'',
        notes:`${part===1?'Loaded portion':'Remaining portion'} of ${parent.tranid}. ${original.notes||''}`,
        splitCorrection:{key:KEY,sourceOrderRef:parent.tranid,portion:part===1?'loaded':'remaining'}});
      // Remove stale source totals from cached raw data; live parent metadata stays authoritative.
      split.raw={...original.raw,tranid:id,items,operator_status:split.operatorStatus,local_yard_order_status:split.localYardOrderStatus,
        total_quantity:String(split.salesQty),total_pallet_qty:String(split.pallets),total_layer_qty:String(split.layers),total_weight_lbs:String(split.weight),
        total_packed_pallet_qty:String(split.packed.pallets),total_packed_layer_qty:'0',total_packed_piece_qty:'0',total_packed_section_qty:'0'};
      splits.push(split);
    }
    assertSplitLineQuantities(original,splits.filter(s=>s.originalOrderId===parent.tranid));
  }
  const first=splits.filter(s=>s.id.endsWith('-S1'));
  const group=totals(aggregateGlobalGroup({...source,id:NEW,plannedOrderRef:NEW,notes:'Grouped orders: '+first.map(s=>s.id).join(', '),
    operatorStatus:'loaded',localYardOrderStatus:'Loaded',packed:{pallets:0,layers:0,sections:0,pieces:0},groupKey:first[0].id},first));
  group.raw={...group.raw,items:group.items,operator_status:'loaded',local_yard_order_status:'Loaded',total_quantity:String(group.salesQty),
    total_pallet_qty:String(group.pallets),total_weight_lbs:String(group.weight),total_packed_pallet_qty:'0'};
  const trucks=plain(state.plan.trucks);
  let changed=0;
  for(const truck of trucks)for(const load of truck.loads||[])for(const stop of load.stops||[]) {
    if(stop.orderId===OLD){assert.equal(load.id,LOAD);stop.orderId=NEW;changed++;}
    if(stop.orderRefs?.includes(OLD)){assert.equal(load.id,LOAD);stop.orderRefs=stop.orderRefs.map(ref=>ref===OLD?NEW:ref);changed++;}
  }
  assert.equal(changed,2);
  const plan={...state.plan,revision:Number(state.plan.revision)+1,trucks,
    orders:[...state.plan.orders.map(o=>o.id===OLD?group:o),...splits.filter(s=>s.id.endsWith('-S2'))],
    summary:{...state.plan.summary,open:Number(state.plan.summary.open)+2}};
  return {splits,group,plan};
}
async function persist(state,next) {
  for(const split of next.splits) {
    const parent=state.headers.find(p=>p.tranid===split.originalOrderId);
    split.netsuiteId=String(await materializeSalesSplitOrder(split,parent));
    split.raw.netsuite_id=split.netsuiteId;
    const first=split.id.endsWith('-S1');
    for(const item of split.items) {
      const source=state.lines.find(l=>l.sales_order_id===parent.netsuite_id && String(l.line_id)===String(item.lineId));
      const result=await query(`UPDATE sales_order_lines SET loaded_qty=$3,loaded_uom=$4,
        packed_pallet_qty=$5,packed_layer_qty=$6,packed_section_qty=$7,packed_piece_qty=$8,packed_sales_qty=$9,
        confirmed=$10,confirmed_at=$11,netsuite_order_line=$12,netsuite_order_line_synced_at=$13
        WHERE sales_order_id=$1 AND line_id=$2 RETURNING id`,
        [split.netsuiteId,item.lineId,first?item.quantity:0,first?source.loaded_uom:'',
          ...packFields.map(k=>first?0:source[k]),first?false:source.confirmed,first?null:source.confirmed_at,source.netsuite_order_line,source.netsuite_order_line_synced_at]);
      assert.equal(result.rowCount,1);
      // Keep the stable source line identity on the Dispatch definition, as normal split materialization does.
    }
    await query('UPDATE sales_orders SET operator_status=$2,local_yard_order_status=$3,status_updated_at=now() WHERE netsuite_id=$1',
      [split.netsuiteId,first?'loaded':'packed',first?'Loaded':'Open']);
    if(first) {
      const result=await query('UPDATE operator_load_records SET order_id=$2,order_ref=$3 WHERE order_id=$1 AND id=ANY($4::bigint[])',
        [parent.netsuite_id,split.netsuiteId,split.id,state.loads.map(l=>l.id)]);
      assert.equal(result.rowCount,1);
    }
  }
  // Move operational progress, leaving the NetSuite source quantities intact. This avoids duplicate packed inventory.
  await query(`UPDATE sales_order_lines SET loaded_qty=0,loaded_uom='',packed_pallet_qty=0,packed_layer_qty=0,
    packed_section_qty=0,packed_piece_qty=0,packed_sales_qty=0,confirmed=false,confirmed_at=null WHERE sales_order_id=ANY($1::bigint[])`,[IDS]);
  await query("UPDATE sales_orders SET operator_status='open',local_yard_order_status='Open',status_updated_at=now() WHERE netsuite_id=ANY($1::bigint[])",[IDS]);
  await syncDispatchGlobalOrderSplitsFromPlan({...next.plan,orders:next.splits,trucks:[]});
  const g={...next.group,planOwned:false,globalGroupDefinition:true,globalGroupSourcePlanId:'366',globalGroupSourcePlanDate:'2026-10-22',groupPlanId:'',groupPlanDate:'',dispatchPlanned:false};
  for(const field of ['originalOrderId','parentOrderRef','resplitSourceOrderId','originalPallets','globalOrderDefinition','globalOrderDefinitionKind','globalOrderSourcePlanId','globalOrderSourcePlanDate','dispatchPlanId','dispatchPlanDate','dispatchTruckPlate','dispatchLoadName','dispatchParkingSpot','dispatchDriverName','dispatchDriverLogin'])delete g[field];
  await query(`INSERT INTO dispatch_global_order_groups(group_ref,order_type,source_plan_id,source_plan_date,full_order,card,search_text,eligible,active,source_revision)
    VALUES($1,'SO',366,'2026-10-22',$2::jsonb,$3::jsonb,$4,true,true,$5)`,[NEW,JSON.stringify(g),JSON.stringify(compactDispatchOrderCard(g)),dispatchOrderSearchText(g),next.plan.revision]);
  await query("UPDATE dispatch_global_order_groups SET active=false,updated_at=now() WHERE group_ref=$1",[OLD]);
  await query(`INSERT INTO dispatch_delivery_groups(group_ref,plan_id,plan_date,order_type,truck_plate,load_name,parking_spot,active)
    SELECT $2,plan_id,plan_date,order_type,truck_plate,load_name,parking_spot,true FROM dispatch_delivery_groups WHERE group_ref=$1`,[OLD,NEW]);
  await query('UPDATE dispatch_delivery_groups SET active=false,updated_at=now() WHERE group_ref=$1',[OLD]);
  for(const table of ['dispatch_global_order_group_members','dispatch_delivery_group_members'])for(const [i,parent] of PARENTS.entries())
    await query(`INSERT INTO ${table}(group_ref,member_order_ref,position) VALUES($1,$2,$3)`,[NEW,parent+'-S1',i]);
  const board=dispatchPlanBoard(state.plan);
  await query(`INSERT INTO dispatch_plan_snapshot_history(plan_id,plan_date,revision,orders,trucks,summary,original_saved_at,archive_reason,session_id,schema_version,plan_digest,order_count,truck_count,load_count,stop_count)
    VALUES(366,'2026-10-22',$1,$2::jsonb,$3::jsonb,$4::jsonb,$5,$6,$6,2,$7,$8,$9,$10,$11)`,
    [state.plan.revision,JSON.stringify(state.plan.orders),JSON.stringify(state.plan.trucks),JSON.stringify(state.plan.summary),state.plan.saved_at,KEY,digestDispatchPlan(state.plan),state.plan.orders.length,board.truckCount,board.loadCount,board.stopCount]);
  assert.equal((await query('UPDATE dispatch_plans SET revision=$1,updated_at=now() WHERE id=366 AND revision=$2',[next.plan.revision,state.plan.revision])).rowCount,1);
  await query(`UPDATE dispatch_plan_snapshots SET orders=$1::jsonb,trucks=$2::jsonb,summary=$3::jsonb,plan_digest=$4,saved_at=now() WHERE plan_id=366`,
    [JSON.stringify(next.plan.orders),JSON.stringify(next.plan.trucks),JSON.stringify(next.plan.summary),digestDispatchPlan(next.plan)]);
  await syncDispatchPlanOrderAssignments(next.plan);
  await syncDispatchPlanRelationEdges(next.plan);
  await query('DELETE FROM dispatch_order_catalog_entries WHERE order_ref=ANY($1)',[[OLD,NEW,...PARENTS,...SPLITS]]);
  await query('UPDATE dispatch_order_catalog_state SET generation=generation+1,catalog_count=(SELECT count(*)::int FROM dispatch_order_catalog_entries),updated_at=now() WHERE singleton=true');
}
async function verify(state,next,inventoryBefore) {
  assert.deepEqual(await protectedState(),state.protected,'Unrelated orders or existing fulfillment evidence changed');
  const stored=await readState();
  assert.deepEqual(stored.loadAssignments,state.loadAssignments,'Route assignment changed');
  assert.deepEqual(stored.plan.orders,next.plan.orders);
  assert.deepEqual(stored.plan.trucks,next.plan.trucks);
  const omit=(row,fields)=>Object.fromEntries(Object.entries(row).filter(([k])=>!fields.includes(k)));
  for(const line of stored.lines)assert.deepEqual(omit(line,[...packFields,'loaded_qty','loaded_uom','confirmed','confirmed_at']),
    omit(state.lines.find(l=>l.id===line.id),[...packFields,'loaded_qty','loaded_uom','confirmed','confirmed_at']));
  for(const header of stored.headers)assert.deepEqual(omit(header,['operator_status','local_yard_order_status','status_updated_at']),
    omit(state.headers.find(h=>h.netsuite_id===header.netsuite_id),['operator_status','local_yard_order_status','status_updated_at']));
  for(const record of stored.loads)assert.deepEqual(omit(record,['order_id','order_ref']),omit(state.loads.find(l=>l.id===record.id),['order_id','order_ref']));
  const families=await rows('SELECT o.tranid,l.* FROM sales_order_lines l JOIN sales_orders o ON o.netsuite_id=l.sales_order_id WHERE o.tranid=ANY($1) ORDER BY o.tranid,l.line_id',[SPLITS]);
  for(const source of state.lines) {
    const ref=state.headers.find(h=>h.netsuite_id===source.sales_order_id).tranid;
    const parts=families.filter(l=>l.tranid.startsWith(ref+'-S') && l.line_id===source.line_id);
    for(const field of ['quantity','loaded_qty',...packFields])assert.equal(round(parts.reduce((n,l)=>n+Number(l[field]||0),0)),Number(source[field]||0),`${ref}/${source.line_id}/${field} conserved`);
  }
  const inventoryAfter=await packedInventorySnapshot([4991,2764,1784],1);
  assert.deepEqual([...inventoryAfter].map(([id,v])=>[id,v.quantity]),inventoryBefore,'Packed stock changed');
  for(const split of next.splits){
    const op=await getDeliveryOrder(split.netsuiteId);
    assert.ok(op,`Operator split missing: ${split.id}`);
    assert.equal(op.operator_status,split.id.endsWith('-S1')?'loaded':'packed');
    const definition=await getDispatchOrderCatalogOrder(split.id);
    assert.ok(definition,`Dispatch split missing: ${split.id}`);
    assert.deepEqual(definition.items.map(i=>[i.lineId,i.quantity]),split.items.map(i=>[i.lineId,i.quantity]));
  }
  const delivery=await getDeliveryOrder('GROUP:'+NEW);
  assert.deepEqual(delivery.child_orders.map(o=>o.tranid).sort(),PARENTS.map(p=>p+'-S1'));
  // Group delivery completion is represented by local_yard_order_status; operator_status describes current packing work.
  assert.equal(delivery.local_yard_order_status,'Loaded');
  assert.equal(delivery.underpack_count,0);
  assert.ok(delivery.child_orders.every(o=>o.operator_status==='loaded' && o.local_yard_order_status==='Loaded'));
  const group=await getDispatchOrderCatalogOrder(NEW);
  assert.deepEqual(group.childOrders,PARENTS.map(p=>p+'-S1'));
  assert.equal(group.pallets,18);
  assert.equal((await rows('SELECT active FROM dispatch_global_order_groups WHERE group_ref=$1',[OLD]))[0].active,false);
  const pool=await listDispatchOrderPool({type:'SO',search:'SOA09623'});
  assert.ok(!(pool.orders||pool).some(o=>o.id==='SOA09623'),'Full parent still offered');
  const untouched=records=>records.filter(r=>r.planned_order_ref!==OLD && r.planned_order_ref!==NEW).map(r=>omit(r,['updated_at']));
  assert.deepEqual(untouched(stored.assignments),untouched(state.assignments),'Unrelated order assignments changed');
  assert.ok(!stored.assignments.some(r=>r.order_ref.endsWith('-S2') && SPLITS.includes(r.order_ref)),'Remainder assigned to current load');
  return {operator:'S1 loaded; S2 packed',dispatchGroup:NEW,dispatchMembers:group.childOrders,plannedPalletSpaces:18,
    sourceQuantitiesConserved:true,packedInventoryConserved:true,loadPhotosAndSnapshotsPreserved:true,existingFulfillmentsPreserved:true,fullyLoaded9883And9884Unchanged:true};
}
async function main() {
  return withTransaction(async()=>{
    await query(APPLY?'SET TRANSACTION ISOLATION LEVEL REPEATABLE READ':'SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await query("SET LOCAL lock_timeout='5s'");await query("SET LOCAL statement_timeout='20s'");
    if(APPLY){
      await query('SELECT pg_advisory_xact_lock(hashtext($1))',[DISPATCH_FLEET_PLANNING_LOCK]);
      await lockConsolidatedLoadOrders([...IDS,'GROUP:'+OLD]);
      for(const ref of [OLD,NEW,...PARENTS,...SPLITS].sort())for(const kind of ['dispatch-global-source-refresh','dispatch-global-order-definition','dispatch-global-order-split'])
        await query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[kind+':'+ref.toLowerCase()]);
    }
    const previous=await rows("SELECT id FROM delivery_audit_log WHERE action='delivery.split.user_corrected' AND details->>'correctionKey'=$1",[KEY]);
    if(previous.length)return {alreadyApplied:true,auditIds:previous.map(p=>p.id)};
    const state=await readState(APPLY);
    await guard(state);
    const next=proposal(state),beforeFingerprint=fingerprint(state);
    const summary=next.splits.map(s=>({ref:s.id,status:s.operatorStatus,items:s.items.map(i=>({sku:i.sku,quantity:i.quantity,unit:i.unit,pallets:i.pallets,layers:i.layers,pieces:i.pieces}))}));
    if(!APPLY)return {preview:true,beforeFingerprint,state,summary};
    assert.equal(process.env.MBBS_REPAIR_EXPECTED,beforeFingerprint,'Live state changed after saved preview');
    const inventoryBefore=[...await packedInventorySnapshot([4991,2764,1784],1)].map(([id,v])=>[id,v.quantity]);
    await persist(state,next);
    const checks=await verify(state,next,inventoryBefore);
    const details={correctionKey:KEY,beforeFingerprint,reason:'User requested loaded portion S1 and remaining S2 for SOA09623/SOA09624; user clarified fully loaded SOA09883/SOA09884 remain unchanged.',
      feePolicy:'Non-loadable Delivery Charge and Sales Credit line quantities remain entirely in S2; original financial source lines unchanged.',state,summary,checks};
    const audit=(await rows("INSERT INTO delivery_audit_log(actor_type,source,action,order_id,details) VALUES('system','authorized-split-correction','delivery.split.user_corrected',1032654,$1::jsonb) RETURNING id",[JSON.stringify(details)]))[0];
    const dispatchAudit=await writeDispatchAudit({action:'order_loaded_portion_split_corrected',entityType:'order',entityId:NEW,orderId:NEW,planId:366,planDate:'2026-10-22',
      operatorName:'maintenance:'+KEY,source:'authorized-split-correction',before:state.global.full_order,after:next.group,details:{correctionKey:KEY,deliveryAuditId:audit.id,checks}});
    return {applied:true,auditId:audit.id,dispatchAuditId:dispatchAudit.id,revision:next.plan.revision,checks,summary};
  });
}
try{console.log(JSON.stringify(await main()));}finally{await closeDb();}
