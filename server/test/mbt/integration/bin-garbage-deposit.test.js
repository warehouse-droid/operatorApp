import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {query,closeDb,withTransaction} from '../../../src/db.js';
import {config} from '../../../src/config.js';
import {rental,actor} from '../support/bin-collection-request-fixtures.js';
import {frontdeskCommand} from '../support/frontdesk-fixtures.js';
import {previewFrontdeskChargeRequest} from '../../../src/mbt/customer-charge-request-service.js';
import {getLocalRateCardGraph} from '../../../src/mbt/rate-card-configuration-service.js';
import {configureGarbageDeposits} from '../../../tools/bin-garbage-deposit-rates.mjs';
after(closeDb);
async function itemRate(size=14,deposit=50000,duplicate=false) {
  const itemCode=`${size}YD`,versionId=crypto.randomUUID();
  const existing=(await query('SELECT rate_card_id FROM mbt_rate_cards WHERE item_code=$1',[itemCode])).rows[0];
  const cardId=existing?.rate_card_id || crypto.randomUUID();
  const binTypeId=`00000000-0000-4000-8000-${String(size).padStart(12,'0')}`;
  if(!existing) await query(`INSERT INTO mbt_rate_cards(rate_card_id,rate_card_code,display_name,item_code,currency,created_by,updated_by)
    VALUES($1,$2,$2,$2,'CAD','test','test')`,[cardId,itemCode]);
  await query("UPDATE mbt_rate_card_versions SET status='retired',retired_at=now() WHERE rate_card_id=$1 AND status='active'",[cardId]);
  await query(`INSERT INTO mbt_rate_card_versions(rate_card_version_id,rate_card_id,version_number,status,effective_from,created_by,updated_by)
    VALUES($1,$2,(SELECT coalesce(max(version_number),0)+1 FROM mbt_rate_card_versions WHERE rate_card_id=$2),'draft','2020-01-01','test','test')`,[versionId,cardId]);
  for (const [kind,basis,amount,service] of [['rental','flat',size===14?0:30000,'delivery'],['extension','per_day',2000,'extension']]) {
    await query(`INSERT INTO mbt_rate_components(rate_component_id,rate_card_version_id,item_code,component_code,component_kind,
      service_code,bin_type_id,rate_basis,amount_minor,currency,taxable) VALUES($1,$2,$3,$4,$4,$5,$6,$7,$8,'CAD',true)`,
      [crypto.randomUUID(),versionId,itemCode,kind,service,binTypeId,basis,amount]);
  }
  if(deposit!==null) for(let i=0;i<(duplicate?2:1);i++) await query(`INSERT INTO mbt_deposit_rules(deposit_rule_id,rate_card_version_id,
    rule_code,rule_type,service_code,fixed_amount_minor,currency,liability_account_mapping_key)
    VALUES($1,$2,$3,'fixed','delivery',$4,'CAD','local_bin_deposit')`,[crypto.randomUUID(),versionId,`garbage_${i}`,deposit]);
  await query("UPDATE mbt_rate_card_versions SET status='active',activated_at=now() WHERE rate_card_version_id=$1",[versionId]);
  return {itemCode,versionId,binTypeId,size};
}
async function preview(f,item,content='garbage') {
  return previewFrontdeskChargeRequest(frontdeskCommand('deposit-change',actor,{kind:'change_bin',contractId:f.contractId,
    serviceLineId:f.line.serviceLineId,expectedContractRevision:f.contract.revision,expectedServiceLineRevision:f.line.revision,
    rateCardVersionId:f.rateCardVersionId,paymentMethod:'cash',billingAddressText:'100 Billing Road',serviceAddressText:'200 Site Road',
    contractTelephone:'4165550123',distanceMetres:12500,bin:{incomingContentCode:content,incomingBinSizeYards:item.size,
      incomingBinTypeId:item.binTypeId,binItemCode:item.itemCode,deliveryItemCode:f.deliveryItemCode,discountMinor:0,
      proposedDeliveryAt:f.proposedDeliveryAt,proposedReturnAt:f.proposedReturnAt}}));
}
for(const size of [14,20]) test(`garbage ${size}YD uses the incoming item deposit, preserving signed revenue and no fixed dumping`,async()=>{
  const f=await rental(false,'soil'),item=await itemRate(size);
  const result=await preview(f,item);
  assert.equal(result.body.request.requiredDepositMinor,50000);
  assert.equal(result.body.request.dueNowMinor,result.body.request.newRequestChargeableMinor+50000);
  const row=(await query('SELECT pricing_snapshot FROM mbt_frontdesk_charge_requests WHERE charge_request_id=$1',[result.body.request.chargeRequestId])).rows[0];
  assert.equal(row.pricing_snapshot.bin.itemEvidence.depositRateCardVersionId,item.versionId);
  assert.equal(row.pricing_snapshot.calculation.revisedCalculation.lines.some(l=>l.lineType==='fixed_dump'),false);
});
test('ambiguous incoming deposit rules are rejected instead of silently selecting or falling back',async()=>{
  const f=await rental(false,'soil'),item=await itemRate(14,50000,true);
  await assert.rejects(preview(f,item),error=>error.code==='MBT_FRONTDESK_DEPOSIT_RATE_AMBIGUOUS');
});
test('rate card graph preserves configured deposit rules',async()=>{
  const item=await itemRate();const detail=await getLocalRateCardGraph(item.versionId);
  assert.equal(detail.graph.depositRules.length,1);assert.equal(detail.graph.depositRules[0].fixedAmountMinor,50000);
});
for(const legacy of [false,true]) test(`garbage deposit setup ${legacy?'legacy component links':'item-bound cards'} versions both sizes, retains rental prices, replays and rolls back`,async()=>{
  config.mbt.enabled=true;config.mbtPhase3.masterDataEnabled=true;
  await query("UPDATE mbt_feature_flags SET enabled=true WHERE flag_key IN ('mbt_enabled','mbt_master_data')");
  const rates=[await itemRate(14,null),await itemRate(20,null)];
  if(legacy) await query(`UPDATE mbt_rate_cards SET item_code=NULL WHERE rate_card_id IN
    (SELECT rate_card_id FROM mbt_rate_card_versions WHERE rate_card_version_id=ANY($1::uuid[]))`,[rates.map(r=>r.versionId)]);
  const input={actor:{operatorId:'authorized-test-admin',roles:['admin']},idempotencyKey:crypto.randomUUID(),
    correlationId:crypto.randomUUID(),requestId:crypto.randomUUID(),versionIds:rates.map(r=>r.versionId),amountMinor:50000};
  await withTransaction(async()=>{
    const result=await configureGarbageDeposits(input);assert.equal(result.body.after.length,2);
  },{rollback:true});
  for(const rate of rates) assert.equal((await getLocalRateCardGraph(rate.versionId)).version.status,'active');
  const result=await configureGarbageDeposits(input);
  for(let i=0;i<2;i++) {
    assert.equal(result.body.after[i].graph.depositRules[0].fixedAmountMinor,50000);
    assert.deepEqual(result.body.after[i].graph.components,result.body.before[i].graph.components);
    assert.equal(result.body.after[i].graph.rateCard.itemCode,result.body.before[i].graph.rateCard.itemCode);
    assert.equal((await getLocalRateCardGraph(rates[i].versionId)).version.status,'retired');
  }
  assert.equal((await configureGarbageDeposits(input)).replayed,true);
});
