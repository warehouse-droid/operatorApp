import assert from "node:assert/strict";
import test, { after } from "node:test";
import fc from "fast-check";
import { query, withTransaction, closeDb } from "../../../src/db.js";
import { getReceivingOrder, confirmReceivingLine, getReceivableReceivingOrder, buildItemReceiptPayload } from "../../../src/receiving-repository.js";

after(closeDb);
import { parent, child, incident, fixture } from "../../support/receiving-split-balance-fixture.mjs";

const scenario = run => withTransaction(run, { rollback: true });
const visible = async id => (await getReceivingOrder(id)).lines.filter(line=>Number(line.quantity)>0 && line.netsuite_active);
const balances = async id => (await visible(id)).map(line=>[line.sku,Number(line.quantity)]);
const beforeState = async()=>Promise.all([
  query("SELECT * FROM purchase_order_lines WHERE purchase_order_id=ANY($1::bigint[]) ORDER BY id",[[parent,child]]),
  query("SELECT * FROM dispatch_scm_po_split_lines ORDER BY id")
]).then(results=>results.map(result=>result.rows));

test("POB03684 exposes only the three unsplit balances and preserves all source and child quantities",()=>scenario(async()=>{
  await fixture(); const before=await beforeState();
  assert.deepEqual(await balances(parent),[["OAK-RKT-SG-1272",108],["OAK-PAV-AB-2424",304],["OAK-PAV-HL-1224",228]]);
  assert.deepEqual(await balances(child),incident.filter(row=>row[3]>0).map(row=>[row[1],row[3]]));
  assert.deepEqual(await beforeState(),before);
}));

test("confirmation caps the parent's partially split line and omits fully assigned stale drafts",()=>scenario(async()=>{
  const {sources}=await fixture();
  await query("UPDATE purchase_order_lines SET received_pallet_qty=pallet_qty,confirmed_at=now() WHERE purchase_order_id=$1",[parent]);
  const line=sources.find(row=>Number(row.line_id)===4878981);
  await confirmReceivingLine(parent,line.id,{pallets:999},null);
  const order=await getReceivableReceivingOrder(parent);
  const payload=buildItemReceiptPayload(order,order.receivableLines).item.items.filter(row=>row.itemReceive);
  assert.deepEqual(payload.map(row=>[row.orderLine,row.quantity]),[[4759374,108],[4878977,304],[4878981,228]]);
}));

test("parent split capacity and cached split receipts overlap instead of subtracting twice",()=>scenario(async()=>{
  await fixture();
  for(const [key,,,received] of incident) await query("UPDATE purchase_order_lines SET netsuite_received_qty=$2 WHERE purchase_order_id=$1 AND line_id=$3",[parent,received,key]);
  assert.deepEqual(await balances(parent),[["OAK-RKT-SG-1272",108],["OAK-PAV-AB-2424",304],["OAK-PAV-HL-1224",228]]);
  await query("UPDATE purchase_order_lines SET netsuite_received_qty=quantity WHERE purchase_order_id=$1",[parent]);
  assert.deepEqual(await balances(parent),[]);
}));

test("cancelled splits release exact-line capacity and repeated SKUs remain independent",()=>scenario(async()=>{
  const {split}=await fixture();
  await query("UPDATE dispatch_scm_po_splits SET status='cancelled' WHERE id=$1",[split]);
  assert.deepEqual(await balances(parent),incident.map(row=>[row[1],row[2]]));
  await query("UPDATE dispatch_scm_po_splits SET status='active' WHERE id=$1",[split]);
  assert.deepEqual((await balances(parent)).filter(row=>row[0]==='OAK-PAV-AB-2424'),[["OAK-PAV-AB-2424",304]]);
}));

test("parent local receipts reduce unsplit capacity without consuming sibling quantities",()=>scenario(async()=>{
  await fixture([[4878981,"OAK-PAV-HL-1224",456,228]]);
  await query(`INSERT INTO receiving_receipt_records(order_id,item_receipt_id,receipt_status,payload)
    VALUES($1,991234,'partial_received',$2)`,[parent,JSON.stringify({item:{items:[{orderLine:4878981,itemReceive:true,quantity:100}]}})]);
  assert.deepEqual(await balances(parent),[["OAK-PAV-HL-1224",128]]);
  assert.deepEqual(await balances(child),[["OAK-PAV-HL-1224",228]]);
  await query("UPDATE purchase_order_lines SET netsuite_received_qty=328 WHERE purchase_order_id=$1",[parent]);
  assert.deepEqual(await balances(parent),[["OAK-PAV-HL-1224",128]]);
}));

test("multiple active splits accumulate by source row while an unrelated PO stays unchanged",()=>scenario(async()=>{
  const {sources}=await fixture([[4878981,"OAK-PAV-HL-1224",456,228]]);
  const second=-260063887792828, unrelated=945686;
  await query(`INSERT INTO purchase_orders(netsuite_id,tranid,status,status_text,destination_location_id,netsuite_active)
    VALUES($1,'SECOND-SPLIT','B','Pending Receipt',1,true),($2,'OTHER-PO','B','Pending Receipt',1,true)`,[second,unrelated]);
  const split=(await query(`INSERT INTO dispatch_scm_po_splits(source_po_id,source_po_ref,split_po_id,split_po_ref)
    VALUES($1,'POB03684',$2,'SECOND-SPLIT') RETURNING id`,[parent,second])).rows[0].id;
  const splitLine=(await query(`INSERT INTO purchase_order_lines(purchase_order_id,line_id,item_id,item_name,sku,item_type,
    quantity,unit,location_id,piece_qty,to_pcs,netsuite_active)
    VALUES($1,4878981,4878981,'OAK-PAV-HL-1224','OAK-PAV-HL-1224','InvtPart',100,'SQFT',1,100,1,true) RETURNING id`,[second])).rows[0].id;
  await query(`INSERT INTO dispatch_scm_po_split_lines(split_id,source_line_id,split_line_id,sales_qty,piece_qty)
    VALUES($1,$2,$3,100,100)`,[split,sources[0].id,splitLine]);
  await query(`INSERT INTO purchase_order_lines(purchase_order_id,line_id,item_id,item_name,sku,item_type,quantity,unit,location_id,netsuite_active)
    VALUES($1,4878981,4878981,'OAK-PAV-HL-1224','OAK-PAV-HL-1224','InvtPart',456,'SQFT',1,true)`,[unrelated]);
  assert.deepEqual(await balances(parent),[["OAK-PAV-HL-1224",128]]);
  assert.deepEqual(await balances(child),[["OAK-PAV-HL-1224",228]]);
  assert.deepEqual(await balances(second),[["OAK-PAV-HL-1224",100]]);
  assert.deepEqual(await balances(unrelated),[["OAK-PAV-HL-1224",456]]);
}));

test("property: source balance respects exact split scope, cancellation, baseline and overlapping NetSuite progress",async()=>{
  await fc.assert(fc.asyncProperty(fc.integer({min:1,max:10000}),fc.integer({min:0,max:10000}),fc.integer({min:0,max:10000}),fc.boolean(),
    async(total,assigned,baseline,cancelled)=>scenario(async()=>{
      const {split,sources}=await fixture([[501,"GENERATED",total,assigned]]);
      if(cancelled) await query("UPDATE dispatch_scm_po_splits SET status='cancelled' WHERE id=$1",[split]);
      const assignedNow=cancelled?0:assigned;
      await query("UPDATE purchase_order_lines SET netsuite_received_baseline_qty=$2,netsuite_received_qty=$3 WHERE id=$1",[sources[0].id,baseline,baseline+Math.floor(assignedNow/2)]);
      const remaining=(await visible(parent)).reduce((sum,line)=>sum+Number(line.quantity),0);
      assert.equal(remaining,Math.max(total-baseline-assignedNow,0));
      if(assigned>0) assert.deepEqual(await balances(child),[["GENERATED",assigned]]);
    })),{seed:20260922,numRuns:60,examples:[[456,228,0,false],[100,60,10,false],[100,150,0,false],[456,228,0,true]]});
});
