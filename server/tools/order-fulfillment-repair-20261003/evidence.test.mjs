import assert from 'node:assert/strict';
import test from 'node:test';
import {verifyIncidentEvidence} from './evidence.mjs';

function fixture(kind) {
  const to = kind === 'TO';
  const id = to ? 1032550 : 1023363;
  const commandId = to ? '46aa605a-5831-471f-9d46-5e3ccba9245b' : '300a2177-ca79-4246-a1a2-b118715da5fd';
  const items = to ? [[5064390,1,2,1189,160],[5064393,4,5,1784,3]] : [[5041423,1,1,5175,209.82],[5041424,2,2,2055,58.59]];
  const ref = to ? 'TOB01183' : 'SOA09472';
  const transactionId = to ? 1036362 : 1035754;
  const transactionRef = to ? 'IF156408' : 'IF156345';
  return {kind, command:{id:commandId, functionKey:to?'delivery_prep':'customer_pickup',
    steps:[{sourceNetSuiteId:id,sourceOrderRef:ref,sourceOrderKind:kind,transactionType:'IF',externalId:`MBBS-OP-${commandId}-1`,
      payload:{item:{items:items.slice(0,to?2:1).map(([,line,,item,quantity])=>({orderLine:line,quantity,itemReceive:true,...(to?{}:{location:1})}))}}}]},
    record:{id:transactionId,tranId:transactionRef,createdFrom:{id},externalId:to?'':`MBBS-OP-${commandId}-1`,
      item:{items:items.map(([,line,remote,item,quantity])=>({orderLine:remote,quantity,itemReceive:true,item:{id:item},location:{id:1}}))}},
    history:[{id:String(transactionId),tranid:transactionRef,type:'ItemShip',status:'C'}],
    sourceRows:items.flatMap(([key,line,remote,item,quantity])=>to?[
      {id:String(id),tranid:ref,status:'F',status_text:'Transfer Order : Pending Receipt',uniquekey:String(key),line:String(line),item:String(item),quantity:String(-quantity),quantityshiprecv:'0',location:'1',itemtype:'InvtPart'},
      {id:String(id),tranid:ref,status:'F',status_text:'Transfer Order : Pending Receipt',uniquekey:String(key+1),line:String(remote),item:String(item),quantity:String(-quantity),quantityshiprecv:String(quantity),location:'1',itemtype:'InvtPart'}
    ]:[{id:String(id),tranid:ref,status:'F',status_text:'Sales Order : Pending Billing',uniquekey:String(key),line:String(line),item:String(item),quantity:String(-quantity),quantityshiprecv:String(quantity),location:'1',itemtype:line===1?'InvtPart':'NonInvtPart'}]),
    localLines:items.map(([key,line,remote,item,quantity])=>({line_id:String(key),netsuite_order_line:String(line),item_id:String(item),quantity:String(quantity),location_id:'1',confirmed:true,loaded_qty:'0',sync_exception:null,netsuite_active:true,
      raw:{sourceLineAliases:[String(key),...(to?[String(key+1)]:[])],orderLineAliases:[String(line),...(to?[String(remote)]:[])]}}))};
}

for(const kind of ['TO','SO']) {
  test(`${kind}: accepts complete independently verified fulfillment and confirmed lines`,()=>{
    const input=fixture(kind), before=structuredClone(input);
    const proof=verifyIncidentEvidence(input);
    assert.equal(proof.orderRef,kind==='TO'?'TOB01183':'SOA09472');
    assert.equal(proof.transactionRef,kind==='TO'?'IF156408':'IF156345');
    assert.equal(proof.lines.length,2);
    assert.deepEqual(input,before);
  });
  test(`${kind}: rejects altered document identity, content or operator confirmation`,()=>{
    const mutations=[
      x=>{x.record.id=999;},x=>{x.record.tranId='OTHER';},x=>{x.record.createdFrom.id=999;},
      x=>{x.record.externalId='wrong';},x=>{x.record.item.items[1].item.id=999;},
      x=>{x.record.item.items[1].quantity+=1;},x=>{x.record.item.items[0].location.id=28;},
      x=>{x.record.item.items[0].itemReceive=false;},x=>{x.record.item.items.pop();},
      x=>{x.record.item.items.push({...x.record.item.items[0],orderLine:99});},
      x=>{x.record.item.items[1].orderLine=x.record.item.items[0].orderLine;},
      x=>{x.history.push({...x.history[0],id:'999'});},x=>{x.history[0].status='A';},
      x=>{x.sourceRows[0].quantity='-1';},x=>{x.sourceRows.at(-1).quantityshiprecv='0';},
      x=>{x.localLines[1].confirmed=false;},x=>{x.localLines[1].item_id='999';},
      x=>{x.localLines[0].quantity='1';},x=>{x.localLines[0].loaded_qty='1';},
      x=>{x.localLines[0].sync_exception='line_deleted';},
      x=>{x.command.steps[0].payload.item.items[0].quantity=1;}
    ];
    for(const [i,change] of mutations.entries()) {
      const input=fixture(kind);change(input);
      assert.throws(()=>verifyIncidentEvidence(input),undefined,`mutation ${i} should be rejected`);
    }
  });
  test(`${kind}: line order does not affect proof`,()=>{
    const input=fixture(kind), expected=verifyIncidentEvidence(input);
    input.localLines.reverse();input.sourceRows.reverse();input.record.item.items.reverse();
    assert.deepEqual(verifyIncidentEvidence(input),expected);
  });
}
test('TO: refuses unproven physical transfer line aliases',()=>{
  const input=fixture('TO');input.localLines[0].raw.sourceLineAliases=['5064390'];
  assert.throws(()=>verifyIncidentEvidence(input));
});
test('SO: accepts additional remote item only with matching confirmed local and source evidence',()=>{
  const input=fixture('SO');input.localLines.pop();
  assert.throws(()=>verifyIncidentEvidence(input));
});
