import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import fc from 'fast-check';
import {createOperatorNetSuitePostingRealSourceResolver, createOperatorNetSuitePostingTargetResolver,
  createOperatorNetSuitePostingLiveSourceFetcher} from '../../../src/operator-netsuite-posting-targets.js';
import {buildOperatorNetSuitePostingDraft} from '../../../src/operator-netsuite-posting-domain.js';

const fixture=JSON.parse(readFileSync(new URL('../../fixtures/to-line-reference-20261003/tob01189.json',import.meta.url)));
const mappingError={code:'OPERATOR_NETSUITE_POSTING_LINE_MAPPING_UNRESOLVED'};
const rows=()=>structuredClone(fixture.rows);
const sourceRows=(lines,stage)=>lines.filter(l=>l.line_stage===stage).map(l=>({...l,source_line_key:String(l.line_id),location_id:null,cached_completed_qty:0}));
const order=(lines,stage='outbound')=>({netsuite_id:1036611,tranid:'TOB01189',order_type:'transfer_order',
  outbound_location_id:1,source_location_id:1,destination_location_id:28,operator_status:'packed',
  lines:lines.filter(l=>l.line_stage===stage)});

test('webhook rows without physical evidence resolve from exact live keys once without changing quantities',async()=>{
 const original=rows(),lines=rows();delete lines[0].raw.physicalRows;delete lines[1].raw.physicalRows;let calls=0;
 const result=await resolver(lines,async()=>{calls++;return {lines:original.map(l=>({raw:l.raw,stage:l.line_stage,itemId:l.item_id,sourceLineKey:String(l.line_id)}))};})(order(lines),{functionKey:'delivery_prep'});
 assert.equal(calls,1);assert.deepEqual(result.availableLines.map(l=>l.orderLine),[2,5,8]);
 assert.deepEqual(lines.map(l=>l.quantity),original.map(l=>l.quantity));
 await assert.rejects(resolver(lines,async()=>({lines:[]}))(order(lines),{functionKey:'delivery_prep'}),mappingError);
});
function resolver(lines,fetchLiveSource){return createOperatorNetSuitePostingRealSourceResolver({useStoredOrderLines:true,
  query:async(sql,params)=>{assert.equal(Number(params[0]),1036611);return {rows:sourceRows(lines,params[1])};},
  fetchLiveSource:fetchLiveSource||(async()=>{throw new Error('Unexpected live source read');})});}
async function draft(lines=rows()){
  const resolve=createOperatorNetSuitePostingTargetResolver({getDeliveryOrder:async()=>order(lines),
    getReceivableReceivingOrder:async()=>null,resolveRealSource:resolver(lines)});
  const resolved=await resolve({functionKey:'delivery_prep',orderId:1036611,orderType:'transfer_order',clientLocationId:1});
  return buildOperatorNetSuitePostingDraft({...resolved,requestId:'9cb210e0-0021-48f9-9475-9937d504fa3e',actorOperatorId:'fixture',photoRefs:[],
    policy:{gateKey:'operator_netsuite_delivery_prep_if_3445',revision:4,effective:true,locationId:1,yardCode:'3445',functionKey:'delivery_prep',transactionType:'IF'}});
}

test('TOB01189 posts exact Operator quantities on fulfillment legs 2,5,8 and preserves source data',async()=>{
  const lines=rows(),before=structuredClone(lines),result=await draft(lines);
  assert.deepEqual(result.steps[0].payload.item.items,[{orderLine:2,itemReceive:true,quantity:5},
    {orderLine:5,itemReceive:true,quantity:1},{orderLine:8,itemReceive:true,quantity:4}]);
  assert.deepEqual(lines,before);
  assert.deepEqual(result.steps[0].lineSnapshot.map(l=>[l.sourceLineKey,l.quantity,l.orderLine]),
    [['5073149',5,2],['5073152',1,5],['5073155',4,8]]);
});

test('TO receiving resolves destination legs 3,6,9 separately from source and fulfillment',async()=>{
  const lines=rows(),result=await resolver(lines)(order(lines,'receiving'),{functionKey:'receiving'});
  assert.deepEqual(result.availableLines.map(l=>[l.orderLine,l.itemId,l.orderedQuantity]),[[3,2299,5],[6,2298,1],[9,1784,4]]);
});

test('property: reordered non-consecutive TO legs keep the selected quantities and never assume +1',async()=>{
  await fc.assert(fc.asyncProperty(fc.uniqueArray(fc.integer({min:20,max:9999}),{minLength:3,maxLength:3}),
    fc.shuffledSubarray([0,1,2],{minLength:3,maxLength:3}),async(ids,indices)=>{
      const lines=rows().filter(l=>l.line_stage==='outbound');
      for(let i=0;i<3;i++){
        lines[i].raw.physicalRows[1].order_line_number=String(ids[i]);
        lines[i].raw.orderLineAliases=[String(lines[i].netsuite_order_line),String(ids[i])];
      }
      const result=await draft(indices.map(i=>lines[i]));
      assert.deepEqual(result.steps[0].payload.item.items.map(l=>[l.orderLine,l.quantity]).sort((a,b)=>a[0]-b[0]),
        ids.map((id,i)=>[id,[5,1,4][i]]).sort((a,b)=>a[0]-b[0]));
    }),{seed:1036611,numRuns:80});
});

test('partial packing and deselected lines stay attached to their original items',async()=>{
  const lines=rows();lines[0].packed_pallet_qty=1;lines[0].packed_piece_qty=0;
  lines[1].packed_piece_qty=0;lines[1].confirmed=false;
  const result=await draft(lines);
  assert.deepEqual(result.steps[0].payload.item.items,[{orderLine:2,itemReceive:true,quantity:2},
    {orderLine:5,itemReceive:false},{orderLine:8,itemReceive:true,quantity:4}]);
});

for(const [name,change]of[
  ['cross-item',l=>{l.raw.physicalRows[1].item_id='999';}],
  ['cross-order',l=>{l.raw.physicalRows[1].id='999';}],
  ['duplicate physical leg',l=>{l.raw.physicalRows.push({...l.raw.physicalRows[1]});}],
  ['wrong stable key',l=>{l.source_line_key='999999';}],
  ['ambiguous mirror',l=>{l.raw.identityStatus='ambiguous';}],
  ['invalid reference',l=>{l.raw.physicalRows[1].order_line_number='1e2';}]
  ,['invalid visibility',l=>{l.raw.physicalRows[1].do_not_print_line='unknown';}]
])test(`TO ${name} evidence cannot produce a fulfillment`,async()=>{
  const lines=sourceRows(rows(),'outbound');change(lines[0]);
  const source=createOperatorNetSuitePostingRealSourceResolver({useStoredOrderLines:true,query:async()=>({rows:lines})});
  await assert.rejects(source(order(rows()),{functionKey:'delivery_prep'}),mappingError);
});

test('live TO mapping uses physical IF/IR legs while validating visible REST source identities',async()=>{
  const logical=rows().map(l=>({...l.raw,sourceLineKey:String(l.line_id),orderLine:l.raw.orderLine,
    orderLineAliases:l.raw.orderLineAliases,sourceLineAliases:l.raw.sourceLineAliases,itemId:Number(l.item_id),
    stage:l.line_stage,quantity:Number(l.quantity),raw:l.raw}));
  const fetcher=createOperatorNetSuitePostingLiveSourceFetcher({
    fetchReconciliationOrders:async()=>[{id:1036611,kind:'TO',lines:logical}],
    fetchSourceItemLines:async()=>[{line:1,item:{id:2299}},{line:4,item:{id:2298}},{line:7,item:{id:1784}}],
    fetchLinkedTransactions:async()=>[]});
  const result=await fetcher({sourceOrderKind:'TO',sourceNetSuiteId:1036611});
  assert.deepEqual(result.lines.map(l=>l.restOrderLine),[2,5,8,3,6,9]);
});
