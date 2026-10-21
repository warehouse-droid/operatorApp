import test from 'node:test';
import assert from 'node:assert/strict';
import {specialFulfillmentEditor} from '../../../public/special-stock-fulfillment.js';

test('active confirmed and planned requests render an independent Note-only editor',()=>{
  for(const planned of [false,true]){
    const html=specialFulfillmentEditor({revision:7,status:'active',stage:'confirmed',closeStatus:'active',
      salesOrderId:42,purchaseOrderId:43,fulfillmentMethod:'yard_pickup',dispatchPlanning:{anyPlanned:planned},remarks:'Note\n中文'});
    assert.match(html,/data-special-note-form/);assert.match(html,/Save note/);assert.match(html,/Note\n中文/);
    const form=html.match(/<form[^>]*data-special-note-form[\s\S]*?<\/form>/)?.[0];assert.ok(form);
    assert.doesNotMatch(form,/name="(?:fulfillmentMethod|deliveryFeeRate|salesInternalRemark)"/);
  }
});

test('terminal requests keep safely escaped multiline Notes read-only',()=>{
  for(const patch of [{closeStatus:'closed'},{closeStatus:'closure_pending'},{operationallyComplete:true},{status:'cancelled'}]){
    const html=specialFulfillmentEditor({revision:7,status:'active',stage:'confirmed',closeStatus:'active',
      salesOrderId:42,fulfillmentMethod:'yard_pickup',remarks:'Note\n</textarea><script>bad()</script>',...patch});
    assert.doesNotMatch(html,/data-special-note-form/);assert.match(html,/&lt;script&gt;bad\(\)&lt;\/script&gt;/);
  }
});
