import assert from "node:assert/strict";
import test, { after } from "node:test";
import fc from "fast-check";
import { query, withTransaction, closeDb } from "../../../src/db.js";
import { buildOperatorNetSuitePostingDraft } from "../../../src/operator-netsuite-posting-domain.js";
import { createOperatorNetSuitePostingRealSourceResolver,
  createOperatorNetSuitePostingTargetResolver } from "../../../src/operator-netsuite-posting-targets.js";

const parentId = 939701;
const splitId = -81664606940713;
const mappingError = { code: "OPERATOR_NETSUITE_POSTING_LINE_MAPPING_UNRESOLVED" };
const incident = [
  [4737066, 1, 4863, 360], [4851526, 24, 1229, 360],
  [4851527, 25, 5022, 288], [4851536, 34, 1784, 28]
];
after(closeDb);

async function fixture(options, run) {
  assert.equal(process.env.MBT_TEST_ISOLATED, "1");
  return withTransaction(async () => {
    await query(`INSERT INTO purchase_orders(netsuite_id,tranid,destination_location_id,netsuite_active)
      VALUES($1,'POB03669',1,true),($2,'SN1400625',1,true)`, [parentId, splitId]);
    const split = (await query(`INSERT INTO dispatch_scm_po_splits
      (source_po_id,source_po_ref,split_po_id,split_po_ref,status)
      VALUES($1,'POB03669',$2,'SN1400625','active') RETURNING id`, [parentId, splitId])).rows[0];
    const localLines = [];
    for (const [key, rest, item, quantity] of incident) {
      const source = (await query(`INSERT INTO purchase_order_lines
        (purchase_order_id,line_id,item_id,item_type,quantity,unit,location_id,netsuite_active)
        VALUES($1,$2,$3,'InvtPart',$4,'PC',1,$5) RETURNING id`,
      [parentId, key, item, quantity + 100, !(options.inactiveSelected && rest === 1)])).rows[0];
      const child = (await query(`INSERT INTO purchase_order_lines
        (purchase_order_id,line_id,item_id,item_type,quantity,unit,location_id,netsuite_active,received_sales_qty)
        VALUES($1,$2,$3,'InvtPart',$4,'PC',1,true,$5) RETURNING *`,
      [splitId, key, item, quantity, rest === 34 ? 0 : quantity])).rows[0];
      localLines.push(child);
      await query(`INSERT INTO dispatch_scm_po_split_lines
        (split_id,source_line_id,split_line_id,item_id,sales_qty)
        VALUES($1,$2,$3,$4,$5)`, [split.id, source.id, child.id, item, quantity]);
    }
    // An active, completed and closed parent remains part of identity validation.
    await query(`INSERT INTO purchase_order_lines
      (purchase_order_id,line_id,item_id,item_type,quantity,location_id,netsuite_active,netsuite_closed,netsuite_received_qty)
      VALUES($1,4999999,4863,'InvtPart',100,1,true,true,100)`, [parentId]);
    const retiredKeys = Array.from({length: options.retiredCount ?? 1}, (_, index) => 4851525 + index * 100);
    for (const key of retiredKeys) {
      await query(`INSERT INTO purchase_order_lines
        (purchase_order_id,line_id,item_id,item_type,quantity,location_id,netsuite_active,sync_exception)
        VALUES($1,$2,1228,'InvtPart',792,1,false,'line_deleted')`, [parentId, key]);
    }
    const lines = incident.map(([key, rest, item, quantity]) => ({
      sourceLineKey: String(key), restOrderLine: rest, itemId: item,
      identityStatus: "exact", stage: "receiving", quantity: quantity + 100,
      remainingQuantity: quantity + 100, completedQuantity: 0, location: 1
    }));
    lines.push({sourceLineKey:"4999999",restOrderLine:63,itemId:4863,
      identityStatus:"exact",stage:"receiving",quantity:100,remainingQuantity:0,completedQuantity:100,location:1});
    const live = { lines: lines.filter(line => line.sourceLineKey !== options.missingActive) };
    if (options.duplicateLive) { live.lines.push({...live.lines[0]}); }
    const order = {netsuite_id:splitId,tranid:"SN1400625",order_type:"purchase_order",
      destination_location_id:1,lines:localLines,receivableLines:localLines.filter(line=>Number(line.received_sales_qty)>0)};
    await query(`UPDATE purchase_order_lines SET netsuite_order_line=CASE line_id
      WHEN 4737066 THEN 1 WHEN 4851526 THEN 24 WHEN 4851527 THEN 25 WHEN 4851536 THEN 34 WHEN 4999999 THEN 63 END
      WHERE purchase_order_id=$1 AND netsuite_active=true`,[parentId]);
    const source = createOperatorNetSuitePostingRealSourceResolver({query, useStoredOrderLines:true,
      fetchLiveSource:async()=>{throw new Error("Direct posting must not read NetSuite source or history");}});
    const resolve = createOperatorNetSuitePostingTargetResolver({
      getDeliveryOrder:async()=>null,getReceivableReceivingOrder:async()=>order,resolveRealSource:source});
    const targets = () => resolve({functionKey:"receiving",orderId:splitId,orderType:"purchase_order",clientLocationId:1});
    return run({targets,source,order,retiredKeys});
  }, {rollback:true});
}

function draft(resolution) {
  return buildOperatorNetSuitePostingDraft({...resolution,
    requestId:"bd8a2298-0c85-49a6-9f62-31b268140625",actorOperatorId:"sn1400625-test",photoRefs:[],
    policy:{gateKey:"operator_netsuite_receiving_ir_3445",revision:1,effective:true,
      functionKey:"receiving",transactionType:"IR",locationId:1,yardCode:"3445"}});
}


test("direct SN1400625 uses saved parent orderLine and preserves the exact receipt and reference fields",async()=>{
  await fixture({},async({targets})=>{
    const command=draft(await targets()); const step=command.steps[0];
    assert.equal(command.inputSnapshot.postingStrategy,"stored_order_line_v1");
    assert.equal(step.sourceNetSuiteId,parentId);
    assert.equal(step.payload.memo,"SN1400625");assert.equal(step.payload.custbody9,"SN1400625");
    assert.deepEqual(step.payload.item.items,[
      {orderLine:1,location:1,itemReceive:true,quantity:360},
      {orderLine:24,location:1,itemReceive:true,quantity:360},
      {orderLine:25,location:1,itemReceive:true,quantity:288},
      {orderLine:34,location:1,itemReceive:false}
    ]);
    assert.ok(command.claims.includes("source:IR:PO:939701"));
  });
});

test("direct posting sends confirmed quantities above cached totals without a live read or silent clamping",async()=>{
  await fixture({},async({targets})=>{
    await query(`UPDATE purchase_order_lines SET quantity=10,netsuite_received_qty=10 WHERE purchase_order_id=$1 AND line_id=4737066`,[parentId]);
    const command=draft(await targets());
    assert.equal(command.steps[0].payload.item.items.find(l=>l.orderLine===1).quantity,360);
    assert.equal(command.lineReconciliation.lines.find(l=>l.orderLine===1).reconciledQuantity,0);
  });
});

test("direct missing stored identity fails without guessing from the unique key",async()=>{
  await fixture({},async({targets})=>{
    await query(`UPDATE purchase_order_lines SET netsuite_order_line=NULL WHERE purchase_order_id=$1 AND line_id=4737066`,[parentId]);
    await assert.rejects(targets(),mappingError);
  });
});

test("direct selected inactive or changed-item source cannot borrow a split mapping",async()=>{
  for(const change of ["netsuite_active=false","item_id=99999"]){
    await fixture({},async({targets})=>{
      await query(`UPDATE purchase_order_lines SET ${change} WHERE purchase_order_id=$1 AND line_id=4737066`,[parentId]);
      await assert.rejects(targets(),mappingError);
    });
  }
});

test("property: exact direct quantity is independent of cached parent totals",async()=>{
  await fc.assert(fc.asyncProperty(fc.integer({min:1,max:1000}),fc.integer({min:0,max:1000}),async(quantity,completed)=>{
    await fixture({},async({targets})=>{
      await query(`UPDATE purchase_order_lines SET quantity=$2,netsuite_received_qty=$3 WHERE purchase_order_id=$1 AND line_id=4737066`,[parentId,quantity,completed]);
      const command=draft(await targets());
      assert.equal(command.steps[0].payload.item.items.find(l=>l.orderLine===1).quantity,360);
      assert.equal(command.inputSnapshot.postingStrategy,"stored_order_line_v1");
    });
  }),{seed:160918,numRuns:24});
});

test("property: missing or duplicate cached orderLine cannot produce an IR",async()=>{
  await fc.assert(fc.asyncProperty(fc.constantFrom(null,24,25,34),async(value)=>{
    await fixture({},async({targets})=>{
      await query(`UPDATE purchase_order_lines SET netsuite_order_line=$2 WHERE purchase_order_id=$1 AND line_id=4737066`,[parentId,value]);
      await assert.rejects(targets(),mappingError);
    });
  }),{seed:160919,numRuns:12});
});

test("stored SO and TO sources preserve repeated items and transfer stages without a network read", async () => {
  await withTransaction(async () => {
    const id = 990930303;
    await query("INSERT INTO sales_orders(netsuite_id,tranid,outbound_location_id) VALUES($1,'DIRECT-SO',1)", [id]);
    await query("INSERT INTO transfer_orders(netsuite_id,tranid) VALUES($1,'DIRECT-TO'),($2,'DIRECT-SPLIT-TO')", [id, -id]);
    await query(`INSERT INTO sales_order_lines(sales_order_id,line_id,item_id,item_type,quantity,netsuite_order_line,netsuite_active)
      VALUES($1,111,42,'InvtPart',5,7,true),($1,222,42,'InvtPart',6,19,true),($1,333,42,'InvtPart',1,NULL,false)`, [id]);
    for (const stage of ["outbound", "receiving"]) {
      await query(`INSERT INTO transfer_order_lines(transfer_order_id,line_stage,line_id,item_id,item_type,quantity,netsuite_order_line,netsuite_active)
        VALUES($1,$2,$3,42,'InvtPart',5,7,true),($1,$2,$4,42,'InvtPart',6,19,true),($1,$2,333,42,'InvtPart',1,NULL,false)`,
      [id, stage, stage === "outbound" ? 111 : 112, stage === "outbound" ? 222 : 223]);
    }
    const source = createOperatorNetSuitePostingRealSourceResolver({ query, useStoredOrderLines: true,
      fetchLiveSource: async () => { throw new Error("Unexpected NetSuite read"); } });
    const so = await source({ netsuite_id: id, order_type: "sales_order" }, { functionKey: "customer_pickup" });
    assert.deepEqual(so.availableLines.map(line => [line.sourceLineKey, line.orderLine, line.itemId, line.location]),
      [["111", 7, 42, 1], ["222", 19, 42, 1]]);
    for (const functionKey of ["delivery_prep", "receiving"]) {
      const to = await source({ netsuite_id: id, order_type: "transfer_order" }, { functionKey });
      assert.deepEqual(to.availableLines.map(line => [line.sourceLineKey, line.orderLine]), functionKey === "receiving"
        ? [["112", 7], ["223", 19]] : [["111", 7], ["222", 19]]);
    }
    const split = (await query(`INSERT INTO dispatch_scm_to_splits(source_to_id,source_to_ref,split_to_id,split_to_ref)
      VALUES($1,'DIRECT-TO',$2,'DIRECT-SPLIT-TO') RETURNING id`, [id, -id])).rows[0];
    const child = (await query(`INSERT INTO transfer_order_lines(transfer_order_id,line_stage,line_id,item_id,item_type,quantity,netsuite_active)
      VALUES($1,'outbound',-777,42,'InvtPart',3,true) RETURNING *`, [-id])).rows[0];
    const parent = (await query("SELECT id FROM transfer_order_lines WHERE transfer_order_id=$1 AND line_stage='outbound' AND line_id=222", [id])).rows[0];
    const order = { netsuite_id: -id, order_type: "transfer_order", lines: [child] };
    await assert.rejects(source(order, { functionKey: "delivery_prep" }), mappingError);
    await query("INSERT INTO dispatch_scm_to_split_lines(split_id,source_line_id,split_line_id) VALUES($1,$2,$3)", [split.id, parent.id, child.id]);
    const mapped = await source(order, { functionKey: "delivery_prep" });
    assert.equal(mapped.sourceNetSuiteId, id);
    assert.deepEqual(mapped.availableLines.find(line => line.orderLine === 19).sourceLineAliases, ["222", "-777"]);
  }, { rollback: true });
});

test("a command cannot mix legacy and direct posting strategies", async () => {
  await fixture({}, async ({targets}) => {
    const resolution = await targets();
    const legacy = {...resolution.targets[0]}; delete legacy.postingStrategy;
    assert.throws(() => draft({...resolution, targets: [...resolution.targets, legacy]}), /cannot mix stored and live/u);
  });
});

test("property: mixed strategies reject independently of target order", async () => {
  await fc.assert(fc.asyncProperty(fc.boolean(), async reverse => {
    await fixture({}, async ({targets}) => {
      const resolution = await targets();
      const legacy = {...resolution.targets[0]}; delete legacy.postingStrategy;
      const combined = [resolution.targets[0], legacy];
      if (reverse) { combined.reverse(); }
      assert.throws(() => draft({...resolution, targets: combined}), /cannot mix stored and live/u);
    });
  }), {seed: 160921, numRuns: 8});
});
