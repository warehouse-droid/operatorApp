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
test('garbage quote: item-owned deposit survives creation and conversion with its exact rate evidence',async()=>{
  const {f,input,options}=await fixture(),card=crypto.randomUUID(),version=crypto.randomUUID(),rule=crypto.randomUUID();
  await query("UPDATE mbt_rate_card_versions SET status='retired',retired_at=now() WHERE status='active' AND rate_card_id IN (SELECT rate_card_id FROM mbt_rate_cards WHERE item_code='14YD')");
  await query(`INSERT INTO mbt_rate_cards(rate_card_id,rate_card_code,display_name,item_code,currency,created_by,updated_by) VALUES($1::uuid,$1::uuid::text,'Bin item rate','14YD','CAD','test','test')`,[card]);
  await query(`INSERT INTO mbt_rate_card_versions(rate_card_version_id,rate_card_id,version_number,status,effective_from,created_by,updated_by) VALUES($1,$2,1,'draft','2020-01-01','test','test')`,[version,card]);
  await query(`INSERT INTO mbt_rate_components(rate_component_id,rate_card_version_id,item_code,component_code,component_kind,service_code,bin_type_id,rate_basis,amount_minor,currency,taxable) VALUES($1,$2,'14YD','rental','rental','delivery',$3,'flat',35000,'CAD',true)`,[crypto.randomUUID(),version,f.binTypeId]);
  await query(`INSERT INTO mbt_rate_components(rate_component_id,rate_card_version_id,item_code,component_code,component_kind,service_code,bin_type_id,rate_basis,amount_minor,currency,taxable) VALUES($1,$2,'14YD','extension','extension','extension',$3,'per_day',2000,'CAD',true)`,[crypto.randomUUID(),version,f.binTypeId]);
  await query(`INSERT INTO mbt_deposit_rules(deposit_rule_id,rate_card_version_id,rule_code,rule_type,service_code,fixed_amount_minor,currency,liability_account_mapping_key) VALUES($1,$2,'garbage','fixed','delivery',50000,'CAD','local_bin_deposit')`,[rule,version]);
  await query("UPDATE mbt_rate_card_versions SET status='active',activated_at=now() WHERE rate_card_version_id=$1",[version]);
  try {
    const {body:{quote}}=await frontdesk.createFrontdeskQuote(input,options);
    assert.equal(quote.depositRequiredMinor,50000);
    assert.equal(quote.serviceLines[0].depositRuleId,rule);
    assert.equal(quote.serviceLines[0].depositRateCardVersionId,version);
    assert.equal((await evidence(quote.quoteId)).deposit_rule_id,null);
    const converted=await convert(quote);
    assert.equal(converted.body.contract.depositRequiredMinor,50000);
    assert.equal(converted.body.serviceLines[0].pricing.depositRuleId,rule);
    assert.equal(converted.body.serviceLines[0].pricing.depositRateCardVersionId,version);
  } finally {await query("UPDATE mbt_rate_card_versions SET status='retired',retired_at=now() WHERE rate_card_version_id=$1",[version]);}
});
