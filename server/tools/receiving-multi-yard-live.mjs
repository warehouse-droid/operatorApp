import assert from 'node:assert/strict';
import { query, withTransaction, closeDb } from '../src/db.js';
import { listReceivingOrders, listReceivingVendors, getReceivingOrder, buildItemReceiptPayload } from '../src/receiving-repository.js';
import { assertOperatorOrderYard } from '../src/operator-yard-authorization.js';
import { scopeReceivingOrderYard } from '../src/receiving-yard-scope.js';

try {
  const report=await withTransaction(async()=>{
    await query('SET TRANSACTION READ ONLY');
    await query("SET LOCAL statement_timeout='20s'");
    const id='1026879';
    const all=await getReceivingOrder(id);
    assert.equal(all.tranid,'SN1401728');
    assert.equal(all.original_tranid,'POB03969');
    const yards=[];
    for(const [yard,count,pallets] of [[1,4,5],[28,3,4]]) {
      const found=await listReceivingOrders({orderType:'purchase_order',destinationLocationId:yard,search:'SN1401728'});
      assert.equal(found.length,1);
      assert.equal(found[0].line_count,count);
      const operator={role:'operator',operatorYardLocationIds:[yard]};
      const detail=await assertOperatorOrderYard(operator,id,{receiving:true,destinationLocationId:yard});
      assert.equal(detail.lines.length,count);
      assert.ok(detail.lines.every(line=>Number(line.location_id)===yard));
      assert.equal(detail.lines.reduce((sum,line)=>sum+Number(line.pallet_qty),0),pallets);
      assert.ok((await listReceivingVendors({destinationLocationId:yard})).some(row=>String(row.vendor_id)===String(all.vendor_id)));
      yards.push({yard:detail.destination_location,lines:count,pallets});
    }
    await assert.rejects(assertOperatorOrderYard({role:'operator',operatorYardLocationIds:[15]},id,
      {receiving:true,destinationLocationId:1}),{status:403});
    // Preview a future receipt entirely in memory; no confirmations or receipts are saved.
    const drafts=all.lines.map(line=>({...line,received_pallet_qty:Number(line.pallet_qty),received_layer_qty:0,
      received_section_qty:0,received_piece_qty:0,received_sales_qty:0}));
    const preview=scopeReceivingOrderYard({...all,receivableLines:drafts},1,{keepAllLines:true});
    const payload=buildItemReceiptPayload(preview,preview.receivableLines);
    const receive=payload.item.items.filter(item=>item.itemReceive);
    const skip=payload.item.items.filter(item=>!item.itemReceive);
    assert.equal(receive.length,4);
    assert.equal(skip.length,3);
    assert.ok(receive.every(item=>item.location===1));
    return{readOnly:true,ref:'SN1401728',po:'POB03969',yards,receiptPreview:{receiveLines:4,skipLines:3},
      poWrites:0,receiptWrites:0,netSuitePosts:0};
  },{rollback:true});
  console.log(JSON.stringify(report));
} finally {await closeDb();}
