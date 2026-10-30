import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {query,closeDb} from '../../../src/db.js';
import {completeMbtDriverBinJob} from '../../../src/mbt/driver-bin-execution-service.js';
import {readBinDumpCharges} from '../../../src/mbt/bin-dump-charge.js';
import {enabledDriverBinBoundary} from '../support/driver-bin-fixtures.js';
import {createLoadedDumpDriverBinFixture} from '../support/driver-bin-scenario-fixtures.js';
import {materialize,start,completionInput,garbageRate} from '../support/bin-dump-charge-fixtures.js';
after(closeDb);
for(const [material,paymentMethod,amount,unit='TONNE'] of [['DUMPGARBAGE','cash',27000],['GARBAGE','card',30510],['SOIL','cash',0],['DUMP_GARBAGE','cash',null,'KG']]) {
  test(`dump charge: ${material}/${paymentMethod} waits for completed collection and replay stays single`,async()=>{
    const f=await createLoadedDumpDriverBinFixture();
    await query('UPDATE mbt_materials SET material_code=$2,revision=revision+1 WHERE material_id=$1',[f.materialId,material]);
    await query(`UPDATE mbt_contracts SET pricing_snapshot=pricing_snapshot||$2::jsonb WHERE contract_id=$1`,[f.contractId,JSON.stringify({chargeRequestId:crypto.randomUUID(),paymentMethod})]);
    if(material!=='SOIL') await garbageRate(f.materialId);
    const [pickup,dump,returned]=await Promise.all(f.jobs.map(materialize));
    const manifest={manifestId:crypto.randomUUID(),schemaVersion:2,planId:f.planId,planRevision:f.assignment.planRevision};
    await start(f,pickup,manifest,1);
    await completeMbtDriverBinJob(completionInput(f,pickup,manifest,2,{schemaVersion:'mbt-driver-bin-event-v1',actionCode:'pickup_loaded_bin',
      scans:[{evidenceCode:'loaded_bin_scan',assetRole:'outgoing',assetId:f.assetId,scannedValue:f.assetCode}],
      photoEvidence:[{evidenceCode:'loaded_condition_photo',ordinal:0}]},[{ordinal:0,reference:`r2://test/${f.suffix}-pickup.jpg`}]),{capability:enabledDriverBinBoundary});
    await start(f,dump,manifest,3);
    await completeMbtDriverBinJob(completionInput(f,dump,manifest,4,{schemaVersion:'mbt-driver-bin-event-v1',actionCode:'dump_bin',
      photoEvidence:[{evidenceCode:'dump_receipt_photo',ordinal:0}],receipt:{dumpSiteId:f.dumpSiteId,materialId:f.materialId,
        ticketNumber:`TICKET-${f.suffix}`,weight:'2.250000',quantity:'2.250000',unitOfMeasure:unit,subtotalMinor:10000,taxMinor:1300,totalMinor:11300,currency:'CAD',receiptPhotoOrdinal:0}},
      [{ordinal:0,reference:`r2://test/${f.suffix}-receipt.jpg`}]),{capability:enabledDriverBinBoundary});
    assert.deepEqual(await readBinDumpCharges(f.contractId),[]);
    await start(f,returned,manifest,5);
    const input=completionInput(f,returned,manifest,6,{schemaVersion:'mbt-driver-bin-event-v1',actionCode:'return_bin',
      photoEvidence:[{evidenceCode:'return_condition_photo',ordinal:0}]},[{ordinal:0,reference:`r2://test/${f.suffix}-return.jpg`}]);
    await assert.rejects(completeMbtDriverBinJob(input,{capability:enabledDriverBinBoundary,hooks:{afterBillingTrigger:()=>{throw new Error('dump charge rollback');}}}),/dump charge rollback/);
    assert.deepEqual(await readBinDumpCharges(f.contractId),[]);
    await completeMbtDriverBinJob(input,{capability:enabledDriverBinBoundary});
    assert.equal((await completeMbtDriverBinJob(input,{capability:enabledDriverBinBoundary})).replayed,true);
    const charges=await readBinDumpCharges(f.contractId);assert.equal(charges.length,1);
    if(amount===null) {
      assert.equal(charges[0].status,'needs_review');assert.match(charges[0].reason,/weight in tonnes/);
      assert.equal(charges[0].customerAmountMinor,undefined);return;
    }
    assert.equal(charges[0].status,material==='SOIL'?'prepaid':'priced');assert.equal(charges[0].customerAmountMinor,amount);
    if(material!=='SOIL') assert.equal(charges[0].ratePerTonneMinor,12000);
  });
}
