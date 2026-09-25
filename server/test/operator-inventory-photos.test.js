import test from 'node:test';
import assert from 'node:assert/strict';
import {verifyDamagePhotos} from '../src/inventory-damage-repository.js';
import {getDamageItem} from '../src/inventory-damage-netsuite.js';
import {closeDb} from '../src/db.js';
test.after(closeDb);
test('D2: verified image read is required; archived images remain valid',async()=>{
  const calls=[];
  const boundary={readPhoto:async()=>({available:false}),ticket:()=>({objectUrl:'https://photo.invalid/object',token:'test-ticket'}),fetchPhoto:async(url,options)=>{calls.push({url,options});return new Response('image',{headers:{'content-type':'image/jpeg'}});}};
  await verifyDamagePhotos(['r2://damage/a.jpg'],'op',boundary);
  assert.equal(calls.length,1);assert.equal(calls[0].options.headers.Range,'bytes=0-0');
  await verifyDamagePhotos(['r2://damage/a.jpg'],'op',{...boundary,readPhoto:async()=>({available:true})});
  assert.equal(calls.length,1,'Archived photo does not require an R2 request');
  for(const response of [new Response('missing',{status:404}),new Response('text',{headers:{'content-type':'text/plain'}})]) {
    await assert.rejects(verifyDamagePhotos(['r2://damage/a.jpg'],'op',{...boundary,fetchPhoto:async()=>response}),/could not be verified/);
  }
});
test('D3: item refresh persists the authoritative sales unit and fails when the SKU is absent',async()=>{
  const sku={item_id:9919,location_id:1,stock_unit:'Ton',sales_unit:'Yard',sales_unit_id:888};let saved;
  const boundary={fetchItem:async(id,yard)=>{assert.equal(id,9919);assert.equal(yard,1);return [sku];},saveItems:async rows=>{saved=rows;}};
  assert.deepEqual(await getDamageItem(9919,1,boundary),sku);assert.deepEqual(saved,[sku]);
  await assert.rejects(getDamageItem(9919,1,{...boundary,fetchItem:async()=>[]}),{status:404});
});
