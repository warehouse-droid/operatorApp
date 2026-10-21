import test from 'node:test';
import assert from 'node:assert/strict';
import {specialOrderSnapshot} from '../../../src/special-stock-documents.js';

const manual={id:43,requestRef:'SPREQ-000043',salesOrderSource:'manual_link',salesOrderId:1041475,salesOrderRef:'SOB122110',
  salesOrderSkipped:false,salesOrderLines:[],customerName:'Fixture customer',storeName:'3445'};
test('a manually linked existing SO can preview its native PDF without a local SO draft',()=>{
  for(const audience of ['sales','scm']){
    const snapshot=specialOrderSnapshot(manual,'sales_order',audience);
    assert.equal(snapshot.id,1041475);assert.equal(snapshot.number,'SOB122110');assert.equal(snapshot.source,'netsuite-native');assert.deepEqual(snapshot.lines,[]);
    assert.deepEqual(specialOrderSnapshot({...manual,salesOrderLines:undefined},'sales_order',audience).lines,[]);
  }
});
test('the manual SO preview exception preserves missing/skipped links and private PO restrictions',()=>{
  for(const change of [{salesOrderId:null},{salesOrderSkipped:true},{salesOrderSource:'standalone'}])assert.throws(()=>specialOrderSnapshot({...manual,...change},'sales_order','sales'),{status:409});
  assert.throws(()=>specialOrderSnapshot({...manual,purchaseOrderId:5,purchaseOrderLines:[]},'purchase_order','sales'),{status:403});
  assert.throws(()=>specialOrderSnapshot({...manual,purchaseOrderId:5,purchaseOrderLines:[]},'purchase_order','scm'),{status:409});
});
