import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {query,pool,closeDb} from '../../../src/db.js';
import {completeMbtDriverBinJob} from '../../../src/mbt/driver-bin-execution-service.js';
import {readBinDumpCharges,completedBinDumpPricing} from '../../../src/mbt/bin-dump-charge.js';
import {createBillingFixture} from '../support/billing-fixtures.js';
import {enabledDriverBinBoundary} from '../support/driver-bin-fixtures.js';
import {createLoadedDumpDriverBinFixture} from '../support/driver-bin-scenario-fixtures.js';
import {materialize,start,completionInput,garbageRate} from '../support/bin-dump-charge-fixtures.js';
after(closeDb);
test('a collection initiated at $120/tonne retains that price when completed after a $200 rate activates',async()=>{
  const f=await createLoadedDumpDriverBinFixture();
  await query("UPDATE mbt_materials SET material_code='DUMPGARBAGE',revision=revision+1 WHERE material_id=$1",[f.materialId]);
  await query(`UPDATE mbt_contracts SET pricing_snapshot=pricing_snapshot||$2::jsonb WHERE contract_id=$1`,
    [f.contractId,JSON.stringify({chargeRequestId:crypto.randomUUID(),paymentMethod:'cash'})]);
  const old=await garbageRate(f.materialId);
  const tariff=(await query('SELECT dump_tariff_id FROM mbt_dump_tariffs WHERE rate_card_version_id=$1',[old])).rows[0];
  await query('UPDATE mbt_service_visits SET service_snapshot=service_snapshot||$2::jsonb WHERE contract_id=$1',
    [f.contractId,JSON.stringify({collectionPricing:{requestedAt:'2020-12-01T00:00:00Z',garbageDump:{status:'priced',ratePerTonneMinor:12000,
      rateCardVersionId:old,dumpTariffId:tariff.dump_tariff_id,materialId:f.materialId}}})]);
  await query("UPDATE mbt_rate_card_versions SET status='retired',effective_to='2021-01-01',retired_at=now(),revision=revision+1 WHERE rate_card_version_id=$1",[old]);
  const current=await garbageRate(f.materialId);
  await query('UPDATE mbt_dump_tariffs SET amount_minor=20000 WHERE rate_card_version_id=$1',[current]);
  const [pickup,dump,returned]=await Promise.all(f.jobs.map(materialize));
  const manifest={manifestId:crypto.randomUUID(),schemaVersion:2,planId:f.planId,planRevision:f.assignment.planRevision};
  await start(f,pickup,manifest,1);
  await completeMbtDriverBinJob(completionInput(f,pickup,manifest,2,{schemaVersion:'mbt-driver-bin-event-v1',actionCode:'pickup_loaded_bin',
    scans:[{evidenceCode:'loaded_bin_scan',assetRole:'outgoing',assetId:f.assetId,scannedValue:f.assetCode}],
    photoEvidence:[{evidenceCode:'loaded_condition_photo',ordinal:0}]},[{ordinal:0,reference:`r2://test/${f.suffix}-pickup.jpg`}]),{capability:enabledDriverBinBoundary});
  await start(f,dump,manifest,3);
  await completeMbtDriverBinJob(completionInput(f,dump,manifest,4,{schemaVersion:'mbt-driver-bin-event-v1',actionCode:'dump_bin',
    photoEvidence:[{evidenceCode:'dump_receipt_photo',ordinal:0}],receipt:{dumpSiteId:f.dumpSiteId,materialId:f.materialId,
      ticketNumber:`TICKET-${f.suffix}`,weight:'2.250000',quantity:'2.250000',unitOfMeasure:'TONNE',subtotalMinor:10000,taxMinor:1300,totalMinor:11300,currency:'CAD',receiptPhotoOrdinal:0}},
    [{ordinal:0,reference:`r2://test/${f.suffix}-receipt.jpg`}]),{capability:enabledDriverBinBoundary});
  assert.deepEqual(await readBinDumpCharges(f.contractId),[]);
  await start(f,returned,manifest,5);
  const input=completionInput(f,returned,manifest,6,{schemaVersion:'mbt-driver-bin-event-v1',actionCode:'return_bin',
    photoEvidence:[{evidenceCode:'return_condition_photo',ordinal:0}]},[{ordinal:0,reference:`r2://test/${f.suffix}-return.jpg`}]);
  await completeMbtDriverBinJob(input,{capability:enabledDriverBinBoundary});
  const charges=await readBinDumpCharges(f.contractId);assert.equal(charges.length,1);
  assert.equal(charges[0].ratePerTonneMinor,12000);assert.equal(charges[0].customerAmountMinor,27000);
  assert.equal(charges[0].rateCardVersionId,old);
});
test('legacy collection uses its request date; missing or conflicting saved prices require review',async()=>{
  const f=await createBillingFixture(pool,{completed:false});
  // The earlier lifecycle fixture owns DUMPGARBAGE; use its equivalent alternate material spelling.
  await query("UPDATE mbt_materials SET material_code='DUMP_GARBAGE',revision=revision+1 WHERE material_id=$1",[f.materialId]);
  await query('UPDATE mbt_contracts SET pricing_snapshot=pricing_snapshot||$2::jsonb WHERE contract_id=$1',
    [f.contractId,JSON.stringify({chargeRequestId:crypto.randomUUID(),paymentMethod:'cash'})]);
  await query("UPDATE mbt_dump_receipts SET weight='2.25' WHERE dump_receipt_id=$1",[f.dumpReceiptId]);
  await query("UPDATE mbt_service_visits SET service_snapshot=service_snapshot||'{\"collectionRequestedAt\":\"2024-01-01T12:00:00Z\"}'::jsonb WHERE service_visit_id=$1",[f.visitId]);
  const old=await garbageRate(f.materialId);
  await query("UPDATE mbt_rate_card_versions SET status='retired',effective_to='2025-01-01',retired_at=now(),revision=revision+1 WHERE rate_card_version_id=$1",[old]);
  const current=await garbageRate(f.materialId);
  await query("UPDATE mbt_rate_card_versions SET effective_from='2025-01-01',revision=revision+1 WHERE rate_card_version_id=$1",[current]);
  await query('UPDATE mbt_dump_tariffs SET amount_minor=22000 WHERE rate_card_version_id=$1',[current]);
  const context={rows:{visit:{service_visit_id:f.visitId}},normalized:{occurredAt:new Date().toISOString()}};
  const oldPrice=await completedBinDumpPricing(context,true);
  assert.equal(oldPrice.rateCardVersionId,old);assert.equal(oldPrice.customerAmountMinor,27000);
  const pin=async garbageDump=>query('UPDATE mbt_service_visits SET service_snapshot=service_snapshot||$2::jsonb WHERE service_visit_id=$1',
    [f.visitId,JSON.stringify({collectionPricing:{garbageDump}})]);
  await pin({status:'needs_review',reason:'No rate was available when requested.'});
  const missing=await completedBinDumpPricing(context,true);assert.equal(missing.status,'needs_review');assert.equal(missing.customerAmountMinor,undefined);
  await pin({status:'priced',ratePerTonneMinor:12000,materialId:crypto.randomUUID()});
  const mismatched=await completedBinDumpPricing(context,true);assert.equal(mismatched.status,'needs_review');assert.match(mismatched.reason,/material differs/);
});
