/* global structuredClone */
import test from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';
import {findLinkedSpecialPurchaseOrder} from '../../../src/special-stock-native-po-adapter.js';

function fixture({linked=true,quantity=98.08,pallets=1,salesRate=6.4,purchaseRate=4.48,palletCost=35}={}) {
  const material={item:{id:'2055'},quantity,units:'866',description:'Reviewed SQFT material'};
  const pallet={item:{id:'1784'},quantity:pallets,units:'246',description:'PALLET'};
  const native=linked?{createdPo:{id:'1042761'},createPo:{id:'SpecOrd'}}:{};
  const so=structuredClone({id:'1042205',orderStatus:{id:'B'},item:{items:[
    {...material,line:1,lineUniqueKey:'5086153',rate:salesRate,...structuredClone(native)},
    {...pallet,line:2,lineUniqueKey:'5086154',rate:40,...structuredClone(native)}
  ]}});
  const po=structuredClone({id:'1042761',tranId:'POB03999',orderStatus:{id:'B'},createdFrom:{id:'1042205'},
    entity:{id:'331'},location:{id:'1'},memo:'Existing vendor note',item:{items:[
      {...material,line:1,rate:purchaseRate},{...pallet,line:2,rate:palletCost}
    ]}});
  const input=structuredClone({salesOrderId:1042205,salesOrderLines:[
    {caseLineId:73,itemId:2055,remoteLineId:5086153,rate:salesRate,ancillary:false},
    {caseLineId:null,itemId:1784,remoteLineId:5086154,rate:40,ancillary:true}
  ],purchaseOrderLines:[{caseLineId:73,itemId:2055,ancillary:false},{caseLineId:null,itemId:1784,ancillary:true}],
  payload:{entity:{id:'331'},location:{id:'1'},memo:'MBBS-SPECIAL-PO:125',item:{items:[
    {...material,rate:purchaseRate},{...pallet,rate:palletCost}
  ]}}});
  const reads=[];
  const boundary={rest:async(path,options={})=>{
    assert.equal(options.method||'GET','GET','Recovery must never write or create another PO');reads.push(path);
    return {data:structuredClone(path.includes('/salesOrder/')?so:po)};
  },queryAll:async(sql)=>sql.includes('FROM item WHERE')?[]:[
    {previousline:1,nextline:1,linktype:'SpecOrd'},{previousline:2,nextline:2,linktype:'SpecOrd'}
  ]};
  return {input,so,po,boundary,reads};
}

test('SPREQ-000041 recovers its existing native PO with a reviewed PALLET and exact SQFT material',async()=>{
  const f=fixture(),original=structuredClone({so:f.so,po:f.po,input:f.input});
  const found=await findLinkedSpecialPurchaseOrder(f.input,f.boundary);
  assert.deepEqual(found,{id:1042761,tranid:'POB03999',entity_id:331,location_id:1,nativeLink:true});
  assert.deepEqual({so:f.so,po:f.po,input:f.input},original);
  assert.equal(f.reads.length,2);
});

test('an unlinked SO permits an independent vendor PALLET review before standalone PO creation',async()=>{
  const f=fixture({linked:false});f.input.payload.item.items[1].quantity=3;
  assert.equal(await findLinkedSpecialPurchaseOrder(f.input,f.boundary),null);
  assert.equal(f.reads.length,1);
});

test('PALLET recovery rejects ambiguous or changed identities, material changes and foreign or partial native links',async()=>{
  for(const change of [
    f=>f.input.salesOrderLines.push({...f.input.salesOrderLines[1]}),
    f=>{f.so.item.items[1].lineUniqueKey='999';},
    f=>{f.so.item.items[1].item.id='2055';},
    f=>{f.so.item.items[0].units='865';},
    f=>{f.so.item.items[0].rate=6.41;},
    f=>{f.so.item.items[0].quantity=98.09;},
    f=>{f.so.item.items[1].createdPo.id='999';},
    f=>{delete f.so.item.items[1].createdPo;delete f.so.item.items[1].createPo;},
    f=>{f.po.entity.id='332';},
    f=>{f.po.location.id='28';},
    f=>{f.po.createdFrom.id='999';},
    f=>{f.po.item.items[1].isClosed=true;},
    f=>{f.po.item.items[1].quantityReceived=1;},
    f=>{f.boundary.queryAll=async()=>[{previousline:1,nextline:1,linktype:'SpecOrd'},{previousline:2,nextline:1,linktype:'SpecOrd'}];}
  ]) {
    const f=fixture();change(f);
    await assert.rejects(findLinkedSpecialPurchaseOrder(f.input,f.boundary),{code:'SPECIAL_NATIVE_PO_CONFLICT'});
  }
});

test('property: native PALLET recovery accepts exact orders and rejects every material UOM and sales-price change',async()=>{
  await fc.assert(fc.asyncProperty(fc.integer({min:1,max:100000}),fc.integer({min:1,max:100}),
    fc.integer({min:0,max:100000}),async(quantity,pallets,cents)=>{
      const f=fixture({quantity:quantity/100,pallets,salesRate:cents/100});
      assert.equal((await findLinkedSpecialPurchaseOrder(f.input,f.boundary)).id,1042761);
      f.so.item.items[0].units='865';
      await assert.rejects(findLinkedSpecialPurchaseOrder(f.input,f.boundary),{code:'SPECIAL_NATIVE_PO_CONFLICT'});
      f.so.item.items[0].units='866';f.so.item.items[0].rate+=0.01;
      await assert.rejects(findLinkedSpecialPurchaseOrder(f.input,f.boundary),{code:'SPECIAL_NATIVE_PO_CONFLICT'});
    }),{numRuns:60,seed:2026100641});
});
