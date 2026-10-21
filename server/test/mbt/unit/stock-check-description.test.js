import test from 'node:test';
import assert from 'node:assert/strict';
import {stockCheckMaterial} from '../../../src/stock-check/line-description.js';
import {matchLineProducts} from '../../../src/stock-check/line-matching.js';
const code='UNI-BH80S-RDM-FOS',description='Beacon Hill 80mm S Rdm Fossil 81.6sqft/plt, 11.66sqft/lyr, 7lyrs/plt';
const regular={workflow_kind:'backorder',product_name:code,regular_item_code:code,detail_spec:description,inventory_description:'Current master description'};
test('regular stock matching uses the saved description and retains the NetSuite code only as a reference',()=>{
  const result=stockCheckMaterial(regular);assert.equal(result.productName,description);assert.equal(result.itemCode,null);assert.equal(result.referenceItemCode,code);
});
test('missing saved descriptions fall back to inventory descriptions or a descriptive material name, never to the internal code',()=>{
  assert.equal(stockCheckMaterial({...regular,detail_spec:''}).productName,regular.inventory_description);
  assert.equal(stockCheckMaterial({...regular,detail_spec:'',inventory_description:'',product_name:'Beacon Hill Smooth Fossil'}).productName,'Beacon Hill Smooth Fossil');
  const missing=stockCheckMaterial({...regular,detail_spec:code,inventory_description:''});assert.equal(missing.productName,'');assert.equal(missing.detailSpec,'');assert.equal(missing.descriptionMissing,true);
});
test('special-order product names and specifications keep their existing meaning',()=>{
  assert.deepEqual(stockCheckMaterial({...regular,workflow_kind:'special',product_name:'Beacon Hill',detail_spec:'81.6 sqft/plt'}),
    {productName:'Beacon Hill',detailSpec:'81.6 sqft/plt',itemCode:code});
});
test('Rdm and Random descriptions exclude individual XL or rectangular catalogue variants',()=>{
  const random={id:1,sku:'RANDOM-1',name:'Beacon Hill Smooth 6cm Fossil',colour:'FOSSIL',size:'Random'},
    xl={...random,id:2,sku:'XL-1',name:'Beacon Hill Smooth XL 6cm Fossil',size:'570mm x 950mm x 60mm'};
  for(const shape of ['Rdm','Random']) {
    const line={productName:'Beacon Hill 60mm S '+shape+' Fossil',color:'',size:'',itemCode:null};
    assert.deepEqual(matchLineProducts(line,[xl,random]).candidates.map(row=>row.id),[1]);
    assert.equal(matchLineProducts({...line,detailSpec:'XL-1'},[xl,random]).product,null);
  }
});
