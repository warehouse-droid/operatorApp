import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fc from 'fast-check';
import {pool,query,closeDb} from '../../../src/db.js';
import {rental,actor} from '../support/bin-collection-request-fixtures.js';
import {command,nextVersion,addInput} from '../support/frontdesk-current-actions-fixtures.js';
import {getFrontdeskCustomerChargeConfiguration,previewFrontdeskChargeRequest,confirmFrontdeskChargeRequest} from '../../../src/mbt/customer-charge-request-service.js';
import {getFrontdeskContractTimeline} from '../../../src/mbt/frontdesk-service.js';
import {completedBinDumpPricing} from '../../../src/mbt/bin-dump-charge.js';
import {createBillingFixture} from '../support/billing-fixtures.js';
import {garbageRate} from '../support/bin-dump-charge-fixtures.js';
after(closeDb);
test('current-action properties: current deposit exactly, unrelated versions rejected, exchange preview stays frozen',async()=>{
  const unrelated=await rental(false,'garbage');
  await fc.assert(fc.asyncProperty(fc.integer({min:10001,max:100000}),async deposit=>{
    const f=await rental(false,'garbage'),current=await nextVersion(f,deposit);
    const configuration=()=>getFrontdeskCustomerChargeConfiguration({actor,contractId:f.contractId,rateCardVersionId:f.rateCardVersionId});
    assert.equal((await configuration()).rateCardVersionId,current);
    await assert.rejects(getFrontdeskCustomerChargeConfiguration({actor,contractId:f.contractId,rateCardVersionId:unrelated.rateCardVersionId}),{code:'MBT_FRONTDESK_RATE_CARD_MISMATCH'});
    const added=await previewFrontdeskChargeRequest(addInput(f));
    assert.equal(added.body.request.requiredDepositMinor,deposit);
    assert.equal(added.body.request.newRequestChargeableMinor,47500);
    await query("UPDATE mbt_service_visits SET status='completed',actual_completed_at=now() WHERE service_line_id=$1 AND service_action='delivery'",[f.line.serviceLineId]);
    const timeline=await getFrontdeskContractTimeline({actor,contractId:f.contractId});
    const input=addInput(f,'exchange_bin');Object.assign(input,{serviceLineId:f.line.serviceLineId,
      expectedContractRevision:timeline.contract.revision,expectedServiceLineRevision:timeline.serviceLines[0].revision});
    Object.assign(input.bin,{outgoingContentCode:'garbage',outgoingBinSizeYards:14});
    const preview=await previewFrontdeskChargeRequest(input);
    await nextVersion(f,deposit+1);
    assert.notEqual((await configuration()).rateCardVersionId,current);
    const result=await confirmFrontdeskChargeRequest(command({chargeRequestId:preview.body.request.chargeRequestId,expectedRevision:1}));
    assert.equal(result.body.request.rateCardVersionId,current);
    const saved=(await query("SELECT service_snapshot FROM mbt_service_visits WHERE service_line_id=$1 AND service_action='exchange_bin'",[f.line.serviceLineId])).rows[0];
    assert.equal(saved.service_snapshot.collectionPricing.rateCardVersionId,current);
    assert.equal((await query('SELECT rate_card_version_id FROM mbt_contracts WHERE contract_id=$1',[f.contractId])).rows[0].rate_card_version_id,f.rateCardVersionId);
  }),{numRuns:6,seed:20261026});
});
test('collection price property: weight times saved tariff, independent of the rate at completion',async()=>{
  const f=await createBillingFixture(pool,{completed:false});
  await query("UPDATE mbt_materials SET material_code='DUMPGARBAGE',revision=revision+1 WHERE material_id=$1",[f.materialId]);
  await query('UPDATE mbt_contracts SET pricing_snapshot=pricing_snapshot||$2::jsonb WHERE contract_id=$1',
    [f.contractId,JSON.stringify({chargeRequestId:crypto.randomUUID(),paymentMethod:'cash'})]);
  const current=await garbageRate(f.materialId);
  const context={rows:{visit:{service_visit_id:f.visitId}},normalized:{occurredAt:new Date().toISOString()}};
  await fc.assert(fc.asyncProperty(fc.integer({min:1,max:20000}),fc.integer({min:1,max:99999}),async(weightMilli,rate)=>{
    await query('UPDATE mbt_dump_tariffs SET amount_minor=$2 WHERE rate_card_version_id=$1',[current,rate+1]);
    await query('UPDATE mbt_dump_receipts SET weight=$2 WHERE dump_receipt_id=$1',[f.dumpReceiptId,(weightMilli/1000).toFixed(3)]);
    await query('UPDATE mbt_service_visits SET service_snapshot=service_snapshot||$2::jsonb WHERE service_visit_id=$1',
      [f.visitId,JSON.stringify({collectionPricing:{garbageDump:{status:'priced',ratePerTonneMinor:rate,dumpTariffId:f.dumpTariffId,rateCardVersionId:f.rateCardVersionId,materialId:f.materialId}}})]);
    assert.equal(await completedBinDumpPricing(context,false),null);
    const charge=await completedBinDumpPricing(context,true);
    assert.equal(charge.ratePerTonneMinor,rate);
    assert.equal(charge.customerAmountMinor,Number((BigInt(weightMilli)*BigInt(rate)+500n)/1000n));
    assert.equal(charge.rateCardVersionId,f.rateCardVersionId);
  }),{numRuns:20,seed:20261026});
});
