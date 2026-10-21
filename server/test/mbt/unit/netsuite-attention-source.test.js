import assert from 'node:assert/strict';
import test,{after} from 'node:test';
import {closeDb} from '../../../src/db.js';
import {fetchSalesOrderFulfillmentStateFromNetSuite} from '../../../src/netsuite.js';
after(closeDb);
const row=(line,item,type,name)=>({id:100,tranid:'SO100',status:'B',order_line:String(500+line),rest_order_line:line,
 item_id:item,item_type:type,item_name:name,is_fulfillable:'T',quantity:-1,fulfilled_quantity:0,location_id:1});
test('billing source rows retain authoritative REST identities solely for explicit deselection',async()=>{
 const result=await fetchSalesOrderFulfillmentStateFromNetSuite(100,{
  query:async()=>({items:[row(1,100,'InvtPart','Stock'),row(3,4646,'NonInvtPart','Sales Credit - Hardscaping'),
   row(5,200,'NonInvtPart','Delivery Charge')]}),
  fetchItems:async()=>[{line:1,item:{id:'100'}},{line:3,item:{id:'4646'}},{line:5,item:{id:'200'}}]});
 assert.deepEqual(result.lines.map(l=>l.orderLine),[1]);
 assert.deepEqual(result.excludedLines,[{orderLine:3,itemId:4646,location:1},{orderLine:5,itemId:200,location:1}]);
});
test('a billing row with no exact REST source match stops before any payload can be sent',async()=>{
 await assert.rejects(fetchSalesOrderFulfillmentStateFromNetSuite(100,{
  query:async()=>({items:[row(1,100,'InvtPart','Stock'),row(3,4646,'NonInvtPart','Sales Credit - Hardscaping')]}),
  fetchItems:async()=>[{line:1,item:{id:'100'}},{line:3,item:{id:'999'}}]}),/billing.*identity/i);
});
