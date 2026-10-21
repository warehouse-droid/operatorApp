import assert from 'node:assert/strict';

export const incidents = {
  TO: {id:1032550, ref:'TOB01183', commandId:'46aa605a-5831-471f-9d46-5e3ccba9245b', transactionId:1036362, transactionRef:'IF156408',
    lines:[{key:5064390,submitted:1,remote:2,item:1189,quantity:160},{key:5064393,submitted:4,remote:5,item:1784,quantity:3}]},
  SO: {id:1023363, ref:'SOA09472', commandId:'300a2177-ca79-4246-a1a2-b118715da5fd', transactionId:1035754, transactionRef:'IF156345',
    lines:[{key:5041423,submitted:1,remote:1,item:5175,quantity:209.82},{key:5041424,submitted:2,remote:2,item:2055,quantity:58.59}]}
};

function one(rows, predicate, description) {
  const found=rows.filter(predicate);
  assert.equal(found.length,1,description);
  return found[0];
}

function verifyLine(kind, expected, record, sourceRows, localLines) {
  const remote=one(record.item.items,l=>Number(l.orderLine)===expected.remote,'Unique fulfillment line');
  assert.notEqual(remote.itemReceive,false);
  assert.equal(Number(remote.item.id),expected.item);
  assert.equal(Number(remote.quantity),expected.quantity);
  assert.equal(Number(remote.location.id),1);
  const local=one(localLines,l=>Number(l.line_id)===expected.key,'Unique local line');
  assert.equal(Number(local.item_id),expected.item);
  assert.equal(Number(local.quantity),expected.quantity);
  assert.equal(Number(local.location_id),1);
  assert.equal(Number(local.netsuite_order_line),expected.submitted);
  assert.equal(Number(local.loaded_qty),0);
  assert.equal(local.confirmed,true,'Only operator-confirmed quantities can be reconciled');
  assert.equal(local.sync_exception,null);
  assert.equal(local.netsuite_active,true);
  const anchor=one(sourceRows,l=>Number(l.uniquekey)===expected.key,'Unique stable source line');
  const shipped=one(sourceRows,l=>Number(l.line)===expected.remote,'Unique shipped source line');
  for(const line of [anchor,shipped]) {
    assert.equal(Number(line.item),expected.item);
    assert.equal(Number(line.quantity),-expected.quantity);
    assert.equal(Number(line.location),1);
  }
  assert.equal(Number(shipped.quantityshiprecv),expected.quantity);
  if(kind==='TO') {
    assert(local.raw.sourceLineAliases.map(String).includes(String(shipped.uniquekey)),'Transfer source alias must prove fulfillment leg');
    assert(local.raw.orderLineAliases.map(String).includes(String(expected.remote)),'Transfer order-line alias must prove fulfillment leg');
  }
  return {...expected,location:1};
}

export function verifyIncidentEvidence({kind,command,record,history,sourceRows,localLines}) {
  const target=incidents[kind];assert(target,'Only the two authorized incidents are supported');
  assert.equal(command.id,target.commandId);
  assert.equal(command.functionKey,kind==='TO'?'delivery_prep':'customer_pickup');
  assert.equal(command.steps.length,1);
  const step=command.steps[0];
  assert.equal(step.sourceNetSuiteId,target.id);
  assert.equal(step.sourceOrderRef,target.ref);
  assert.equal(step.sourceOrderKind,kind);
  assert.equal(step.transactionType,'IF');
  assert.equal(step.externalId,`MBBS-OP-${target.commandId}-1`);
  assert.equal(Number(record.id),target.transactionId);
  assert.equal(record.tranId,target.transactionRef);
  assert.equal(Number(record.createdFrom.id),target.id);
  assert.equal(record.externalId||'',kind==='SO'?step.externalId:'');
  assert.equal(history.length,1,'Exactly one existing fulfillment and no receipts');
  assert.equal(Number(history[0].id),target.transactionId);
  assert.equal(history[0].tranid,target.transactionRef);
  assert.equal(history[0].type,'ItemShip');
  assert.equal(history[0].status,'C','Fulfillment is shipped');
  assert.equal(record.item.items.length,2,'Unexpected fulfillment lines require separate investigation');
  assert.equal(localLines.length,2,'Unexpected local lines require separate investigation');
  assert(sourceRows.length>=2);
  for(const source of sourceRows) {
    assert.equal(Number(source.id),target.id);
    assert.equal(source.tranid,target.ref);
    assert.equal(source.status,'F');
  }
  const selected=step.payload.item.items.filter(l=>l.itemReceive!==false&&Number(l.quantity)>0);
  const intended=target.lines.slice(0,kind==='TO'?2:1);
  assert.equal(selected.length,intended.length);
  for(const line of intended) {
    const submitted=one(selected,l=>Number(l.orderLine)===line.submitted,'Unique submitted line');
    assert.equal(Number(submitted.quantity),line.quantity);
  }
  return {orderId:target.id,orderRef:target.ref,transactionId:target.transactionId,transactionRef:target.transactionRef,
    lines:target.lines.map(line=>verifyLine(kind,line,record,sourceRows,localLines)),
    sourceStatus:'F',sourceStatusText:sourceRows[0].status_text,
    reason:kind==='TO'?'Reconcile later manual fulfillment to previously confirmed load; submitted anchor lines differ from shipped transfer legs.'
      :'Reconcile original fulfillment including the operator-confirmed special-order line omitted from the submitted inventory-only payload.'};
}
