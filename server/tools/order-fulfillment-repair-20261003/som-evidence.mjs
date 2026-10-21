import assert from 'node:assert/strict';
export function verifySomEvidence({command,record,sourceRows,webhook,localLines,history}) {
 assert.equal(command.id,'39221e63-f94a-4329-ae2d-fe9c55788b61');assert.equal(command.functionKey,'customer_pickup');
 assert.equal(command.steps.length,1);const step=command.steps[0];assert.equal(step.sourceNetSuiteId,1033859);
 assert.equal(step.sourceOrderRef,'SOM06812');assert.equal(step.externalId,`MBBS-OP-${command.id}-1`);
 assert.deepEqual(step.payload.item.items,[{location:26,quantity:1.3,orderLine:1,itemReceive:true}]);
 assert.equal(Number(record.id),1033754);assert.equal(record.tranId,'IF156257');assert.equal(record.externalId,step.externalId);
 assert.equal(Number(record.createdFrom.id),1033859);assert.equal(record.item.items.length,1);
 const item=record.item.items[0];assert.equal(Number(item.item.id),9915);assert.equal(Number(item.orderLine),1);
 assert.equal(Number(item.quantity),1);assert.equal(item.unitsDisplay,'Yard');assert.equal(String(item.units),'882');assert.equal(Number(item.location.id),26);
 assert.equal(history.length,1);assert.equal(Number(history[0].id),1033754);assert.equal(history[0].status,'C');
 assert.equal(sourceRows.length,1);const source=sourceRows[0];assert.equal(Number(source.id),1033859);assert.equal(source.tranid,'SOM06812');
 assert.equal(source.status,'F');assert.equal(Number(source.uniquekey),5066647);assert.equal(Number(source.item),9915);
 assert.equal(Number(source.quantity),-1.3);assert.equal(Number(source.quantityshiprecv),1.3);assert.equal(String(source.units),'882');
 assert.equal(Number(webhook.id),1033859);assert.equal(webhook.tranid,'SOM06812');assert.equal(webhook.lines.length,1);
 const native=webhook.lines[0];assert.equal(Number(native.lineUniqueKey),5066647);assert.equal(Number(native.itemId),9915);
 assert.equal(Number(native.quantity),1);assert.equal(native.unit,'Yard');assert.equal(Number(native.locationId),26);
 assert.equal(localLines.length,1);const local=localLines[0];assert.equal(Number(local.id),498743);assert.equal(Number(local.line_id),5066647);
 assert.equal(Number(local.item_id),9915);assert.equal(Number(local.quantity),1.3);assert.equal(Number(local.packed_sales_qty),1.3);
 assert.equal(Number(local.loaded_qty),0);assert.equal(local.confirmed,true);assert.equal(local.unit,'Yard');assert.equal(local.netsuite_active,true);assert.equal(local.sync_exception,null);
 return {orderRef:'SOM06812',orderId:1033859,transactionRef:'IF156257',transactionId:1033754,itemId:9915,sourceLineKey:5066647,
   oldQuantity:1.3,salesQuantity:1,salesUom:'Yard',baseUnitsPerSalesUnit:1.3,
   reason:'Correct raw base quantity mislabeled as Yard using the original native sales notification and exact shipped IF; preserve the original posting request as historical evidence.'};
}
