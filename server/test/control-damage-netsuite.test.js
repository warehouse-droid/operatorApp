import test from 'node:test';
import assert from 'node:assert/strict';
import {fetchInventoryItemUnitsFromNetSuite,inventoryTransferRest} from '../src/netsuite.js';
import {createControlDamageNetSuite} from '../src/control-damage-netsuite.js';
test('CN1: configured sales and stock units require only Item access, with no Units list request',async()=>{
  const calls=[];
  const units=await fetchInventoryItemUnitsFromNetSuite(5020,{
    queryAll:async sql=>{calls.push(sql);return [{id:'5020',sales_unit_id:'188',sales_unit:'SQFT',stock_unit_id:'191',stock_unit:'PCS'}];},
    rest:()=>assert.fail('Do not request the NetSuite Units list')
  });
  assert.match(calls[0],/id=5020 AND isinactive='F' AND itemtype='InvtPart'/);
  assert.match(calls[0],/BUILTIN.DF\(saleunit\)/);assert.equal(calls.length,1);
  assert.deepEqual(units,[{id:'188',label:'SQFT'},{id:'191',label:'PCS'}]);
  const same=await fetchInventoryItemUnitsFromNetSuite(1,{queryAll:async()=>[{id:1,sales_unit_id:191,sales_unit:'PCS',stock_unit_id:191,stock_unit:'PCS'}]});
  assert.deepEqual(same,[{id:'191',label:'PCS'}]);
});
test('CN2: invalid SKU IDs, unavailable items and malformed configured units fail closed',async()=>{
  for(const id of [0,-1,'1 OR 1=1',1.2]) await assert.rejects(fetchInventoryItemUnitsFromNetSuite(id,{queryAll:()=>assert.fail('invalid query')}));
  for(const rows of [[],[{id:2,sales_unit_id:191,sales_unit:'PCS'}],[{id:1}],[{id:1,sales_unit_id:0,sales_unit:'Bad'}],[{id:1,sales_unit_id:191}]]) {
    await assert.rejects(fetchInventoryItemUnitsFromNetSuite(1,{queryAll:async()=>rows,rest:()=>assert.fail('Units list request')}));
  }
  assert.deepEqual(await fetchInventoryItemUnitsFromNetSuite(1,{queryAll:async()=>[{id:1,stock_unit_id:191,stock_unit:'PCS'}]}),[{id:'191',label:'PCS'}]);
});
test('CN3: keyed updates append safely, removals use replace inventory and cannot inject paths',async()=>{
  const calls=[],remote=createControlDamageNetSuite({rest:async(...args)=>calls.push(args)});
  const update={replace:false,payload:{inventory:{items:[{line:3,adjustQtyBy:4}]}}};
  await remote.apply(998187,update);
  const remove={replace:true,payload:{inventory:{items:[{line:1}]}}};
  await remote.apply(998187,remove);
  assert.deepEqual(calls,[['/998187',{method:'PATCH',body:update.payload}],['/998187?replace=inventory',{method:'PATCH',body:remove.payload}]]);
  await assert.rejects(remote.apply('998187?replace=other',update));
  for(const suffix of ['/1?replace=other','/1/other','/1?expandSubResources=true&replace=inventory']) await assert.rejects(inventoryTransferRest(suffix),/Invalid/);
  await assert.rejects(inventoryTransferRest('/1',{method:'DELETE'}),/Invalid/);
});
