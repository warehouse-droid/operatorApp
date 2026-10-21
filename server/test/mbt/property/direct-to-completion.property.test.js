import assert from 'node:assert/strict';
import test from 'node:test';
import fc from 'fast-check';
import {transferPostingPhysicalStatus} from '../../../src/transfer-order-posting-domain.js';
test('property: direct IR needs its genuine receipt and complete same-source IF quantities',()=>{
  fc.assert(fc.property(fc.tuple(...Array.from({length:6},()=>fc.boolean())),([receipt,posted,source,scope,item,quantity])=>{
    const job={id:'IR',local_to_id:42,order_ref:'TO42',transaction_type:'IR',snapshot:{planId:'10',loadId:'same',planDate:'2026-10-07',
      driverTarget:{orderRefs:['SO42']},lines:[{itemId:1256,quantity:26},{itemId:1784,quantity:1}]}};
    const load={...job,id:'IF',transaction_type:'IF',operator_record_valid:true,status:posted?'completed':'waiting_driver',
      snapshot:{...job.snapshot,loadId:scope?'same':'other',lines:[{itemId:item?1256:999,quantity:quantity?26:25},{itemId:1784,quantity:1}]},
      result:{transactions:[{transactionType:'IF',sourceOrderKind:'TO',sourceNetSuiteId:source?42:43,sourceOrderRef:'TO42',transactionId:1}]}};
    assert.equal(transferPostingPhysicalStatus(job,[{...job,operator_record_valid:receipt},load])===null,
      receipt&&posted&&source&&scope&&item&&quantity);
  }),{seed:1045195,numRuns:250});
});
