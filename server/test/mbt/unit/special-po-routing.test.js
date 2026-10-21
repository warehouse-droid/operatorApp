import assert from 'node:assert/strict';
import test from 'node:test';
import {specialPoRoutingHtml,specialPoRoutingPatch} from '../../../public/special-stock-po-routing.js';

const detail={purchaseOrderId:20,purchaseOrderRef:'TEST-PO',stage:'confirmed',storeName:'3445',closeStatus:'active'};
const order={id:'TEST-PO',vendorYard:'TEST Yard',scm:{method:'MBT',status:'Hold',isSpecialOrder:true}};
test('routing is available after creation and disabled for closed, pending-adjustment and locked requests',()=>{
  for(const patch of [{purchaseOrderId:null},{purchaseOrderRef:null},{stage:'closed'},{stage:'completed'},{closeStatus:'closure_pending'},{quantityReviewPending:true}]) {
    assert.equal(specialPoRoutingHtml({...detail,...patch},{ref:'TEST-PO',order}),'');
  }
  assert.match(specialPoRoutingHtml(detail,{ref:'TEST-PO',order}),/scm-mini-row scm-mini-routing-row/);
  assert.match(specialPoRoutingHtml({...detail,purchaseOrderApproved:false},{ref:'TEST-PO',order}),/Save Schedule/);
  const locked={...order,scmSplitLocked:true};
  assert.match(specialPoRoutingHtml(detail,{ref:'TEST-PO',order:locked}),/<fieldset disabled>/);
  assert.throws(()=>specialPoRoutingPatch(null,locked),/editable PO/);
  assert.throws(()=>specialPoRoutingPatch(null,null),/editable PO/);
});
test('routing keeps derived status and missing vendor maps read-only and escapes values',()=>{
  const html=specialPoRoutingHtml(detail,{ref:'TEST-PO',order:{...order,scm:{status:'Completed',remarkOverride:'</textarea><img src=x>',pickupPoint:'A " > <img src=x>'}}});
  assert.match(html,/value="Completed" readonly/);
  assert.doesNotMatch(html,/data-scm-field="status"|data-scm-field="pickupPoint"/);
  assert.doesNotMatch(html,/<img/);
  assert.match(html,/&lt;\/textarea&gt;/);
});
test('routing never renders a different PO record, and failed loads expose retry',()=>{
  assert.doesNotMatch(specialPoRoutingHtml(detail,{ref:'OTHER',order}),/data-special-po-routing-form/);
  assert.match(specialPoRoutingHtml(detail,null),/Loading PO routing/);
  const failed=specialPoRoutingHtml(detail,{ref:'TEST-PO',error:'<script>error</script>'});
  assert.match(failed,/reload-po-routing/);assert.doesNotMatch(failed,/<script>/);
});
