import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {query,closeDb} from '../../../src/db.js';
import * as frontdesk from '../../../src/mbt/frontdesk-service.js';
import {createFrontdeskPrerequisites,quoteCommand,frontdeskCommand,frontdeskDistanceResolver,frontdeskTaxResolver} from '../support/frontdesk-fixtures.js';
after(closeDb);
const actor={operatorId:'quote-edit-regression',roles:['mbt_frontdesk']};
async function fixture(fixed=true) {
  const f=await createFrontdeskPrerequisites({label:crypto.randomUUID()});
  const input=quoteCommand(f,{actor,identity:crypto.randomUUID()});
  if(fixed) Object.assign(input,{paymentMethod:'cash',billingAddressText:'100 Billing Road',serviceAddressText:'200 Site Road',contractTelephone:'4165550123',
    dumpItemCode:undefined,estimatedTonnes:undefined,contentCode:'garbage',discountMinor:0});
  return {f,input,options:{resolveDistance:frontdeskDistanceResolver(f),resolveTaxPolicy:frontdeskTaxResolver}};
}
const edit=(input,quote,changes={})=>({...input,quoteId:quote.quoteId,expectedRevision:quote.revision,idempotencyKey:crypto.randomUUID(),...changes});
async function evidence(id) {
  return (await query(`SELECT q.*, (SELECT jsonb_agg(to_jsonb(r) ORDER BY r.charge_request_id) FROM mbt_frontdesk_charge_requests r WHERE r.source_quote_id=q.quote_id) AS charges FROM mbt_quotes q WHERE quote_id=$1`,[id])).rows[0];
}
async function convert(quote) {
  await frontdesk.issueFrontdeskQuote(frontdeskCommand('issue',actor,{quoteId:quote.quoteId,expectedRevision:quote.revision,validUntil:'2037-08-04T12:00:00Z'}));
  await frontdesk.acceptFrontdeskQuote(frontdeskCommand('accept',actor,{quoteId:quote.quoteId,expectedRevision:quote.revision+1,acceptedAt:'2037-08-03T10:00:00Z'}));
  return frontdesk.convertFrontdeskQuote(frontdeskCommand('convert',actor,{quoteId:quote.quoteId,expectedRevision:quote.revision+2}));
}
test('draft edit: keeps quote identity, reprices, audits, cancels old charge, replays and converts only the latest draft',async()=>{
  const {input,options}=await fixture(),created=await frontdesk.createFrontdeskQuote(input,options),before=created.body.quote;
  const command=edit(input,before,{discountMinor:5000,discountReason:'Customer agreed discount'});
  const result=await frontdesk.createFrontdeskQuote(command,options),after=result.body.quote;
  assert.equal(after.quoteId,before.quoteId);assert.equal(after.quoteNumber,before.quoteNumber);assert.equal(after.revision,2);assert.equal(after.status,'draft');
  assert.equal(after.pricing.totalMinor,42500);assert.equal(after.depositRequiredMinor,10000);
  assert.equal((await frontdesk.createFrontdeskQuote(command,options)).replayed,true);
  await assert.rejects(frontdesk.createFrontdeskQuote(edit(input,before),options),{code:'MBT_STALE_REVISION'});
  const row=await evidence(before.quoteId);assert.equal(row.charges.length,2);
  assert.deepEqual(row.charges.map(c=>c.status).sort(),['cancelled','draft']);
  assert.equal(row.charges.find(c=>c.status==='cancelled').charge_request_id,created.body.chargeRequest.chargeRequestId);
  assert.equal((await query("SELECT count(*)::int AS n FROM mbt_audit_events WHERE entity_id=$1 AND action='mbt.frontdesk.quote.updated'",[before.quoteId])).rows[0].n,1);
  const converted=await convert(after);assert.equal(converted.body.contract.pricing.totalMinor,42500);
  const final=await evidence(before.quoteId);assert.deepEqual(final.charges.map(c=>c.status).sort(),['cancelled','confirmed']);
  await assert.rejects(frontdesk.createFrontdeskQuote(edit(input,{...after,revision:5}),options),{code:'MBT_FRONTDESK_QUOTE_STATE_CONFLICT'});
});
test('draft edit: invalid pricing and cross-customer input leave the quote and charge unchanged',async()=>{
  const {input,options}=await fixture(),{body:{quote}}=await frontdesk.createFrontdeskQuote(input,options),before=await evidence(quote.quoteId);
  await assert.rejects(frontdesk.createFrontdeskQuote(edit(input,quote,{discountMinor:999999,discountReason:'Too much'}),options));
  assert.deepEqual(await evidence(quote.quoteId),before);
  const other=await fixture();
  await assert.rejects(frontdesk.createFrontdeskQuote(edit(other.input,quote),other.options),{code:'MBT_FRONTDESK_QUOTE_CUSTOMER_CONFLICT'});
  assert.deepEqual(await evidence(quote.quoteId),before);
  await assert.rejects(frontdesk.createFrontdeskQuote(edit(input,quote,{actor:{operatorId:'driver',roles:['driver']}}),options));
  assert.deepEqual(await evidence(quote.quoteId),before);
});
test('draft edit: concurrent edits and edit-versus-issue each have one winner',async()=>{
  for(const race of ['edit','issue']) {
    const {input,options}=await fixture(),{body:{quote}}=await frontdesk.createFrontdeskQuote(input,options);
    const results=await Promise.allSettled([
      frontdesk.createFrontdeskQuote(edit(input,quote,{discountMinor:1000,discountReason:'First change'}),options),
      race==='edit'?frontdesk.createFrontdeskQuote(edit(input,quote,{discountMinor:2000,discountReason:'Second change'}),options)
        :frontdesk.issueFrontdeskQuote(frontdeskCommand('issue',actor,{quoteId:quote.quoteId,expectedRevision:1,validUntil:'2037-08-04T12:00:00Z'}))
    ]);
    assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
    assert.equal(Number((await evidence(quote.quoteId)).revision),2);
    const current=await evidence(quote.quoteId);
    if(current.status==='issued') await assert.rejects(frontdesk.createFrontdeskQuote(edit(input,{...quote,revision:2}),options),{code:'MBT_FRONTDESK_QUOTE_STATE_CONFLICT'});
  }
});
test('draft edit: legacy multi-line pricing keeps quote identity and recalculates authoritative totals',async()=>{
  const {f,input,options}=await fixture(false),{body:{quote}}=await frontdesk.createFrontdeskQuote(input,options);
  const result=await frontdesk.createFrontdeskQuote(edit(input,quote,{serviceLines:[1,2].map(()=>({binTypeId:f.binTypeId,proposedDeliveryAt:f.proposedDeliveryAt,proposedReturnAt:f.proposedReturnAt}))}),options);
  assert.equal(result.body.quote.quoteId,quote.quoteId);assert.equal(result.body.quote.revision,2);assert.equal(result.body.quote.serviceLines.length,2);
  assert.equal(result.body.quote.pricing.totalMinor,107350);
});
