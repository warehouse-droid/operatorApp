import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import {closeDb} from '../../../src/db.js';
import {transportSourceFromOrder} from '../../../src/mbt/bin-transport-sources.js';
after(closeDb);
test('Transport source quantities contain physical sales and rental cargo, excluding delivery fees and financial lines',()=>{
  const items=[
    {lineRowId:'rental',itemId:1,itemName:'Excavator/Day',itemType:'Service',quantity:1},
    {lineRowId:'sale',itemId:2,itemName:'Tool',itemType:'InvtPart',quantity:2},
    {lineRowId:'special',itemId:2055,itemName:'MBBS-Special Order',itemType:'NonInvtPart',quantity:1},
    {lineRowId:'delivery',itemId:3,itemName:'Delivery Charge',itemType:'OthCharge',quantity:1},
    {lineRowId:'handling',itemId:4,itemName:'Handling',itemType:'Other Charge',quantity:1},
    {lineRowId:'protection',itemId:5,itemName:'Protection plan',itemType:'Service',quantity:1},
    {lineRowId:'shipping',itemId:6,itemName:'Shipping fee',quantity:1},
    {lineRowId:'tax',itemId:7,itemName:'Tax',itemType:'TaxItem',quantity:1},
    {lineRowId:'subtotal',itemId:8,itemName:'Subtotal',itemType:'Subtotal',quantity:1}
  ];
  const source=transportSourceFromOrder({id:'SOR123',type:'SO',items},'sor_delivery');
  assert.deepEqual(source.snapshot.lines.map(line=>[line.key,line.quantity]),[['rental','1'],['sale','2'],['special','1']]);
});
