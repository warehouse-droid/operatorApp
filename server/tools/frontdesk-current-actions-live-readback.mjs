// Read-only operational verification, executed inside the deployed app container.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
const {query,withTransaction,closeDb}=await import('/app/src/db.js');
const {getFrontdeskCustomerContracts,getFrontdeskContractTimeline}=await import('/app/src/mbt/frontdesk-service.js');
const {getFrontdeskCustomerChargeConfiguration}=await import('/app/src/mbt/customer-charge-request-service.js');
const actor={operatorId:'frontdesk-current-actions-readback',roles:['mbt_frontdesk']};
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
try {
  const audit=await withTransaction(async()=>{
    await query('SET TRANSACTION READ ONLY');
    const row=(await query(`SELECT contract_id,contract_number,customer_netsuite_id,rate_card_version_id,pricing_snapshot
      FROM mbt_contracts WHERE contract_number='MBT-C-96ED89AC9B9B'`)).rows[0];
    assert(row,'Affected contract must exist');
    const originalHash=hash(row.pricing_snapshot);
    const configuration=await getFrontdeskCustomerChargeConfiguration({actor,contractId:row.contract_id,rateCardVersionId:row.rate_card_version_id});
    const version=(await query(`SELECT v.rate_card_version_id,v.version_number,v.status FROM mbt_rate_card_versions v
      JOIN mbt_rate_card_versions original ON original.rate_card_id=v.rate_card_id
      WHERE original.rate_card_version_id=$1 AND v.status='active'`,[row.rate_card_version_id])).rows[0];
    assert.equal(configuration.rateCardVersionId,version.rate_card_version_id);
    const full=await getFrontdeskCustomerContracts({actor,customerNetsuiteId:row.customer_netsuite_id});
    const short=await getFrontdeskCustomerContracts({actor,customerNetsuiteId:row.customer_netsuite_id,summary:true});
    assert.deepEqual(short.items.map(c=>c.contractId),full.items.map(c=>c.contractId));
    assert(short.items.every(c=>!Object.hasOwn(c,'pricing')));
    const timeline=await getFrontdeskContractTimeline({actor,contractId:row.contract_id});
    assert(Array.isArray(timeline.chargeRequests));
    assert.equal(hash((await query('SELECT pricing_snapshot FROM mbt_contracts WHERE contract_id=$1',[row.contract_id])).rows[0].pricing_snapshot),originalHash);
    return {verifiedAt:new Date().toISOString(),readOnly:true,contractNumber:row.contract_number,
      historicalRateCardVersionId:row.rate_card_version_id,currentActionRate:version,originalPricingHash:originalHash,
      originalPricingPreserved:true,contractCount:short.items.length,
      fullListBytes:Buffer.byteLength(JSON.stringify(full)),summaryListBytes:Buffer.byteLength(JSON.stringify(short)),
      timelineIncludesChargeHistory:true,chargeRequestCount:timeline.chargeRequests.length};
  });
  console.log(JSON.stringify(audit,null,2));
} finally {await closeDb();}
