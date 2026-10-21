import assert from 'node:assert/strict';

export function kitFixture({kitQuantity=16,componentCount=1,backorder=78}={}) {
 const rows=[];
 const add=(itemId,itemName,itemType,quantity,unit,backorderedQuantity=0,parent=null)=>{
  const restId=rows.length+1;
  rows.push({id:1032523,tranid:'SO-KIT',order_location_id:1,customer_id:42,status:'B',
   line_id:5064227+restId,rest_line_id:restId,item_id:itemId,item_name:itemName,item_type:itemType,
   quantity:-quantity,backordered_quantity:backorderedQuantity,stock_unit:unit,location_id:28,
   fulfilled_quantity:0,billed_quantity:0,line_closed:'F',kit_member_of:parent});
  return restId;
 };
 add(1189,'Backordered material','InvtPart',160,'PC',backorder);
 const parentId=add(10126,'A kit with an arbitrary name','Kit',kitQuantity,undefined);
 for(let index=0;index<componentCount;index++)add(599+index,'Kit component '+index,'InvtPart',kitQuantity,'EACH',0,parentId);
 add(599,'Separately ordered component','InvtPart',16,'EACH');
 add(1987,'Delivery Charge','OthCharge',1,undefined);
 const writes=[];
 const boundary={
  queryAll:async()=>structuredClone(rows),
  rest:async(_path,options={})=>{
   if(options.method==='PATCH'){
    assert.deepEqual(Object.keys(options.body),['item']);
    for(const update of options.body.item.items){
     assert.deepEqual(Object.keys(update),['line','location']);
     const row=rows.find(entry=>entry.rest_line_id===update.line);
     row.location_id=Number(update.location.id);
     for(const component of rows.filter(entry=>entry.kit_member_of===row.rest_line_id))component.location_id=row.location_id;
    }
    writes.push(structuredClone(options.body));
   }else assert.equal(options.method,undefined);
   return {data:{id:1032523,tranId:'SO-KIT',location:{id:1},entity:{id:42},item:{items:rows.filter(row=>!row.kit_member_of).map(row=>({
    line:row.rest_line_id,lineUniqueKey:String(row.line_id),item:{id:String(row.item_id)},
    quantity:Math.abs(row.quantity),location:{id:String(row.location_id)},rate:10
   }))}}};
  },
  resolveYards:async()=>[1,28,15,26].map(value=>({localLocationId:value,netsuiteLocationId:value}))
 };
 return {rows,boundary,writes,parent:rows.find(row=>row.item_type==='Kit'),components:rows.filter(row=>row.kit_member_of)};
}
