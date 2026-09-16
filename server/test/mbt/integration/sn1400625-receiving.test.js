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
    const source = createOperatorNetSuitePostingRealSourceResolver({query, fetchLiveSource:async()=>live});
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

test("SN1400625 ignores deleted parent history and preserves the exact three confirmed receipt lines", async () => {
  await fixture({}, async ({targets,retiredKeys}) => {
    const resolution=await targets();
    assert.deepEqual(resolution.targets[0].selectedLines.map(line=>[line.orderLine,line.quantity,line.sourceLineKey]),
      incident.slice(0,3).map(([key,rest,_item,quantity])=>[rest,quantity,String(key)]));
    assert.equal(resolution.targets[0].availableLines.some(line=>retiredKeys.includes(Number(line.sourceLineKey))),false);
    const step=draft(resolution).steps[0];
    assert.equal(step.sourceNetSuiteId,parentId);
    assert.equal(step.sourceOrderRef,"POB03669");
    assert.equal(step.payload.memo,"SN1400625");
    assert.deepEqual(step.payload.item.items,[
      {orderLine:1,location:1,itemReceive:true,quantity:360},
      {orderLine:24,location:1,itemReceive:true,quantity:360},
      {orderLine:25,location:1,itemReceive:true,quantity:288},
      {orderLine:34,location:1,itemReceive:false}
    ]);
  });
});

test("active missing and ambiguous live identities still reject SN1400625", async () => {
  for (const options of [{retiredCount:0,missingActive:"4999999"},{retiredCount:0,duplicateLive:true}]) {
    await fixture(options, async ({targets})=>assert.rejects(targets(),mappingError));
  }
});

test("a selected split source marked inactive is rejected even when NetSuite still returns its key", async () => {
  await fixture({retiredCount:0,inactiveSelected:true}, async ({targets})=>assert.rejects(targets(),mappingError));
});

test("property: retired PO history never changes successful native or split line resolution", async () => {
  await fc.assert(fc.asyncProperty(fc.integer({min:1,max:8}),fc.boolean(),async (retiredCount,native)=>{
    await fixture({retiredCount},async ({source,order,targets})=>{
      if (native) {
        const resolved=await source({...order,netsuite_id:parentId,tranid:"POB03669"},{functionKey:"receiving"});
        assert.deepEqual(resolved.availableLines.map(line=>line.orderLine),[1,24,25,34,63]);
      } else {
        assert.deepEqual(draft(await targets()).steps[0].payload.item.items.filter(line=>line.itemReceive)
          .map(line=>[line.orderLine,line.quantity]),[[1,360],[24,360],[25,288]]);
      }
    });
  }),{seed:1400625,numRuns:24});
});

test("property: every required active parent key must still exist, including unselected closed lines", async () => {
  await fc.assert(fc.asyncProperty(fc.constantFrom("4737066","4851526","4851527","4851536","4999999"),
    fc.boolean(),async (missingActive,native)=>{
      await fixture({retiredCount:0,missingActive},async ({source,order,targets})=>{
        const result=native ? source({...order,netsuite_id:parentId},{functionKey:"receiving"}) : targets();
        await assert.rejects(result,mappingError);
      });
    }),{seed:1400626,numRuns:24});
});

test("property: inactive selected sources cannot borrow a still-live key through a split", async () => {
  await fc.assert(fc.asyncProperty(fc.integer({min:0,max:8}),async retiredCount=>{
    await fixture({retiredCount,inactiveSelected:true},async ({targets})=>assert.rejects(targets(),mappingError));
  }),{seed:1400627,numRuns:12});
});
