import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {query,closeDb} from '../../../src/db.js';
import {rental,actor} from '../support/bin-collection-request-fixtures.js';
import {getFrontdeskCustomerChargeConfiguration,previewFrontdeskChargeRequest,confirmFrontdeskChargeRequest} from '../../../src/mbt/customer-charge-request-service.js';
import {collectFrontdeskServiceLine,getFrontdeskContractTimeline,getFrontdeskCustomerContracts} from '../../../src/mbt/frontdesk-service.js';
after(closeDb);
import {command,nextVersion,addInput} from '../support/frontdesk-current-actions-fixtures.js';
import {garbageRate} from '../support/bin-dump-charge-fixtures.js';
test('retired contract: action configuration and new add-bin use current version; initiated price survives a later update',async()=>{
  const f=await rental(false,'garbage'),original=(await query('SELECT pricing_snapshot FROM mbt_contracts WHERE contract_id=$1',[f.contractId])).rows[0];
  const current=await nextVersion(f);
  const config=await getFrontdeskCustomerChargeConfiguration({actor,contractId:f.contractId,rateCardVersionId:f.rateCardVersionId});
  assert.equal(config.rateCardVersionId,current);
  const preview=await previewFrontdeskChargeRequest(addInput(f)),request=preview.body.request;
  assert.equal(request.rateCardVersionId,current);assert.equal(request.requiredDepositMinor,25000);assert.equal(request.newRequestChargeableMinor,47500);
  await nextVersion(f,35000);
  const confirmed=await confirmFrontdeskChargeRequest(command({chargeRequestId:request.chargeRequestId,expectedRevision:1}));
  assert.equal(confirmed.body.request.requiredDepositMinor,25000);
  assert.equal((await query('SELECT source_charge_request_id FROM mbt_contract_service_lines WHERE service_line_id=$1',
    [confirmed.body.operation.serviceLine.serviceLineId])).rows[0].source_charge_request_id,request.chargeRequestId);
  assert.deepEqual((await query('SELECT pricing_snapshot FROM mbt_contracts WHERE contract_id=$1',[f.contractId])).rows[0],original);
  const timeline=await getFrontdeskContractTimeline({actor,contractId:f.contractId});
  assert.equal(timeline.chargeRequests.filter(row=>row.chargeRequestId===request.chargeRequestId).length,1);
});
test('new actions reject an unrelated rate card and keep original contract evidence',async()=>{
  const f=await rental(false,'garbage'),other=await rental(false,'garbage');
  await nextVersion(f);
  await assert.rejects(previewFrontdeskChargeRequest({...addInput(f),rateCardVersionId:other.rateCardVersionId}),{code:'MBT_FRONTDESK_RATE_CARD_MISMATCH'});
  await assert.rejects(getFrontdeskCustomerChargeConfiguration({actor,contractId:f.contractId,rateCardVersionId:other.rateCardVersionId}),{code:'MBT_FRONTDESK_RATE_CARD_MISMATCH'});
});
test('new collection records current action rate while historical contract remains unchanged',async()=>{
  const f=await rental(false,'garbage'),current=await nextVersion(f);
  const garbage=await garbageRate(null);
  await query("UPDATE mbt_service_visits SET status='completed',actual_completed_at=now() WHERE service_line_id=$1 AND service_action='delivery'",[f.line.serviceLineId]);
  const revision=Number((await query('SELECT revision FROM mbt_contract_service_lines WHERE service_line_id=$1',[f.line.serviceLineId])).rows[0].revision);
  const collected=await collectFrontdeskServiceLine(command({contractId:f.contractId,serviceLineId:f.line.serviceLineId,expectedRevision:revision,
    collectionWindow:{startAt:'2037-08-20T12:00:00Z',endAt:'2037-08-20T16:00:00Z'}}));
  const visit=(await query('SELECT service_snapshot FROM mbt_service_visits WHERE service_visit_id=$1',[collected.body.collectionVisit.visitId])).rows[0];
  assert.equal(visit.service_snapshot.collectionPricing.rateCardVersionId,current);
  assert.equal(visit.service_snapshot.collectionPricing.garbageDump.rateCardVersionId,garbage);
  assert.equal(visit.service_snapshot.collectionPricing.garbageDump.ratePerTonneMinor,12000);
  assert.equal((await query('SELECT rate_card_version_id FROM mbt_contracts WHERE contract_id=$1',[f.contractId])).rows[0].rate_card_version_id,f.rateCardVersionId);
  await nextVersion(f,45000);
  await query('UPDATE mbt_dump_tariffs SET amount_minor=22000 WHERE rate_card_version_id=$1',[garbage]);
  const rescheduled=await collectFrontdeskServiceLine(command({contractId:f.contractId,serviceLineId:f.line.serviceLineId,
    expectedRevision:collected.body.serviceLine.revision,collectionWindow:{startAt:'2037-08-21T12:00:00Z',endAt:'2037-08-21T16:00:00Z'}}));
  const saved=(await query('SELECT service_snapshot FROM mbt_service_visits WHERE service_visit_id=$1',[rescheduled.body.collectionVisit.visitId])).rows[0];
  assert.deepEqual(saved.service_snapshot.collectionPricing,visit.service_snapshot.collectionPricing);
});
test('customer list supports compact summaries while full API responses remain available',async()=>{
  const f=await rental(false,'garbage');
  const full=await getFrontdeskCustomerContracts({actor,customerNetsuiteId:f.customerNetsuiteId});
  const short=await getFrontdeskCustomerContracts({actor,customerNetsuiteId:f.customerNetsuiteId,summary:true});
  assert.equal(short.items[0].contractId,full.items[0].contractId);
  assert.equal(short.items[0].contractNumber,full.items[0].contractNumber);
  assert.equal(short.items[0].openServiceLineCount,full.items[0].openServiceLineCount);
  assert.ok(full.items[0].pricing);assert.equal(short.items[0].pricing,undefined);
  assert.ok(JSON.stringify(short).length<JSON.stringify(full).length/3);
});
test('new exchange and bin change use current rates; confirming exchange keeps its preview version',async()=>{
  for (const kind of ['exchange_bin','change_bin']) {
    const f=await rental(false,'garbage'),current=await nextVersion(f,27000);
    if(kind==='exchange_bin') await query("UPDATE mbt_service_visits SET status='completed',actual_completed_at=now() WHERE service_line_id=$1 AND service_action='delivery'",[f.line.serviceLineId]);
    const timeline=await getFrontdeskContractTimeline({actor,contractId:f.contractId});
    const input=addInput(f,kind);Object.assign(input,{serviceLineId:f.line.serviceLineId,expectedContractRevision:timeline.contract.revision,expectedServiceLineRevision:timeline.serviceLines[0].revision});
    Object.assign(input.bin,{outgoingContentCode:'garbage',outgoingBinSizeYards:14});
    const preview=await previewFrontdeskChargeRequest(input);
    assert.equal(preview.body.request.rateCardVersionId,current);
    await nextVersion(f,47000);
    const confirmed=await confirmFrontdeskChargeRequest(command({chargeRequestId:preview.body.request.chargeRequestId,expectedRevision:1}));
    assert.equal(confirmed.body.request.rateCardVersionId,current);
    if(kind==='exchange_bin') {
      const exchange=(await query("SELECT service_snapshot FROM mbt_service_visits WHERE service_line_id=$1 AND service_action='exchange_bin'",[f.line.serviceLineId])).rows[0];
      assert.equal(exchange.service_snapshot.collectionPricing.rateCardVersionId,current);
      assert.equal((await query("SELECT rate_card_version_id FROM mbt_contract_amendments WHERE contract_id=$1 AND amendment_type='swap_exchange'",[f.contractId])).rows[0].rate_card_version_id,current);
    }
  }
});
test('missing contract, unknown version, inactive card and missing active version fail without changing the contract',async()=>{
  const f=await rental(false,'garbage');
  const config=fields=>getFrontdeskCustomerChargeConfiguration({actor,contractId:f.contractId,rateCardVersionId:f.rateCardVersionId,...fields});
  await assert.rejects(config({contractId:crypto.randomUUID()}),{code:'MBT_FRONTDESK_CONTRACT_NOT_FOUND'});
  await assert.rejects(config({rateCardVersionId:crypto.randomUUID()}),{code:'MBT_FRONTDESK_RATE_CARD_MISMATCH'});
  await query('UPDATE mbt_rate_cards SET active=false WHERE rate_card_id=$1',[f.rateCardId]);
  await assert.rejects(config({}),{code:'MBT_FRONTDESK_RATE_NOT_ACTIVE'});
  await query('UPDATE mbt_rate_cards SET active=true WHERE rate_card_id=$1',[f.rateCardId]);
  const current=await nextVersion(f);
  await query("UPDATE mbt_rate_card_versions SET status='retired',retired_at=now(),revision=revision+1 WHERE rate_card_version_id=$1",[current]);
  await assert.rejects(previewFrontdeskChargeRequest(addInput(f)),{code:'MBT_FRONTDESK_RATE_NOT_ACTIVE'});
  assert.equal((await query('SELECT count(*)::int AS n FROM mbt_contract_service_lines WHERE contract_id=$1',[f.contractId])).rows[0].n,1);
});
