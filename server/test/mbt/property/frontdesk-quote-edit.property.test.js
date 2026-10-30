import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fc from 'fast-check';
import {query,closeDb} from '../../../src/db.js';
import {createFrontdeskQuote,issueFrontdeskQuote} from '../../../src/mbt/frontdesk-service.js';
import {createFrontdeskPrerequisites,quoteCommand,frontdeskCommand,frontdeskDistanceResolver,frontdeskTaxResolver} from '../support/frontdesk-fixtures.js';
after(closeDb);
test('draft quote properties: exact discount, identity, revision, one live charge and immutable issued price',async()=>{
  const actor={operatorId:'quote-property',roles:['mbt_frontdesk']};
  await fc.assert(fc.asyncProperty(fc.integer({min:0,max:40000}),async discount=>{
    const f=await createFrontdeskPrerequisites({label:crypto.randomUUID()});
    const options={resolveDistance:frontdeskDistanceResolver(f),resolveTaxPolicy:frontdeskTaxResolver};
    const input={...quoteCommand(f,{actor,identity:crypto.randomUUID()}),paymentMethod:'cash',contentCode:'garbage',
      billingAddressText:'100 Billing Road',serviceAddressText:'200 Site Road',contractTelephone:'4165550123',
      dumpItemCode:undefined,estimatedTonnes:undefined};
    const {body:{quote}}=await createFrontdeskQuote(input,options);
    const edit={...input,quoteId:quote.quoteId,expectedRevision:1,idempotencyKey:crypto.randomUUID(),discountMinor:discount,discountReason:'Property discount'};
    const {body:{quote:updated}}=await createFrontdeskQuote(edit,options);
    assert.equal(updated.quoteId,quote.quoteId);assert.equal(updated.quoteNumber,quote.quoteNumber);assert.equal(updated.revision,2);
    assert.equal(updated.pricing.totalMinor,47500-discount);assert.equal(updated.depositRequiredMinor,10000);
    assert.equal((await query("SELECT count(*)::int AS n FROM mbt_frontdesk_charge_requests WHERE source_quote_id=$1 AND status='draft'",[quote.quoteId])).rows[0].n,1);
    await assert.rejects(createFrontdeskQuote({...edit,idempotencyKey:crypto.randomUUID()},options),{code:'MBT_STALE_REVISION'});
    await assert.rejects(createFrontdeskQuote({...edit,expectedRevision:2,customerNetsuiteId:'123',idempotencyKey:crypto.randomUUID()},options),{code:'MBT_FRONTDESK_QUOTE_CUSTOMER_CONFLICT'});
    await issueFrontdeskQuote(frontdeskCommand('issue',actor,{quoteId:quote.quoteId,expectedRevision:2,validUntil:'2037-08-04T12:00:00Z'}));
    await assert.rejects(createFrontdeskQuote({...edit,expectedRevision:3,idempotencyKey:crypto.randomUUID()},options),{code:'MBT_FRONTDESK_QUOTE_STATE_CONFLICT'});
  }),{numRuns:6,seed:20261026});
});
