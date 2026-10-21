import test from 'node:test';import assert from 'node:assert/strict';import {verifySomEvidence} from './som-evidence.mjs';
const commandId='39221e63-f94a-4329-ae2d-fe9c55788b61',externalId=`MBBS-OP-${commandId}-1`;
function fixture(){return {command:{id:commandId,functionKey:'customer_pickup',steps:[{sourceNetSuiteId:1033859,sourceOrderRef:'SOM06812',externalId,payload:{item:{items:[{location:26,quantity:1.3,orderLine:1,itemReceive:true}]}}}]},
record:{id:1033754,tranId:'IF156257',externalId,createdFrom:{id:1033859},item:{items:[{item:{id:9915},orderLine:1,quantity:1,unitsDisplay:'Yard',units:'882',location:{id:26}}]}},history:[{id:1033754,status:'C'}],
sourceRows:[{id:1033859,tranid:'SOM06812',status:'F',uniquekey:5066647,item:9915,quantity:-1.3,quantityshiprecv:1.3,units:'882'}],
webhook:{id:1033859,tranid:'SOM06812',lines:[{lineUniqueKey:5066647,itemId:9915,quantity:1,unit:'Yard',locationId:26}]},
localLines:[{id:498743,line_id:5066647,item_id:9915,quantity:1.3,packed_sales_qty:1.3,loaded_qty:0,confirmed:true,unit:'Yard',netsuite_active:true,sync_exception:null}]};}
test('SOM06812 requires native sale and IF to both prove 1 Yard',()=>assert.equal(verifySomEvidence(fixture()).salesQuantity,1));
test('quantity, UOM, identity, duplicate and incomplete evidence fail closed',()=>{for(const mutate of [e=>e.record.item.items[0].quantity=1.3,e=>e.record.item.items[0].unitsDisplay='Ton',e=>e.webhook.lines[0].quantity=1.3,e=>e.sourceRows[0].quantityshiprecv=0,e=>e.history.push({...e.history[0]}),e=>e.record.externalId+='x',e=>e.localLines[0].confirmed=false,e=>e.localLines[0].loaded_qty=1]){const e=fixture();mutate(e);assert.throws(()=>verifySomEvidence(e));}});
