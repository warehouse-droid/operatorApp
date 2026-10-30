// Authorized configuration maintenance. Run through node stdin in the live app.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {query,withTransaction,closeDb} from '/app/src/db.js';
import {
  getLocalRateCardGraph,normalizeLocalRateCardGraph,cloneLocalRateCardVersion,
  replaceLocalRateCardDraft,validateLocalRateCardVersion,activateLocalRateCardVersion
} from '/app/src/mbt/rate-card-configuration-service.js';

const operation='mbt-shared-delivery-20261026';
const cardCode='DELIVERY_CHARGE_MBT_2026_RATE';
const actor={operatorId:`authorized-maintenance:${operation}`,roles:['admin']};
const reason='User confirmed: use the existing MBT delivery rates for all bin sizes.';
const command=(stage,values)=>({actor,reason,correlationId:operation,requestId:`${operation}:${stage}`,
  idempotencyKey:`${operation}:${stage}`,...values});
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');

async function matches(versionId) {
  return (await query(`SELECT t.type_code, y.yard, d.metres, count(b.rate_distance_band_id)::int AS matches
    FROM mbt_bin_types t CROSS JOIN (VALUES ('2967'),('3445')) y(yard)
    CROSS JOIN (VALUES (0),(30000),(30001),(50000),(50001),(65000),(65001),(75000),(75001),(100000)) d(metres)
    LEFT JOIN mbt_rate_distance_bands b ON b.rate_card_version_id=$1::uuid
      AND b.item_code='DELIVERY_CHARGE_MBT' AND b.service_code='delivery'
      AND (b.bin_type_id IS NULL OR b.bin_type_id=t.bin_type_id)
      AND (cardinality(b.origin_yard_codes)=0 OR y.yard=ANY(b.origin_yard_codes))
      AND ((b.boundary_rule='upper_inclusive'
        AND CASE WHEN b.minimum_metres=0 THEN d.metres>=b.minimum_metres ELSE d.metres>b.minimum_metres END
        AND (b.maximum_metres IS NULL OR d.metres<=b.maximum_metres))
       OR (b.boundary_rule='lower_inclusive' AND b.minimum_metres<=d.metres
        AND (b.maximum_metres IS NULL OR b.maximum_metres>d.metres)))
    WHERE t.active GROUP BY t.type_code,y.yard,d.metres ORDER BY t.type_code,y.yard,d.metres`,[versionId])).rows;
}

try {
  const report=await withTransaction(async()=>{
    await query("SET LOCAL lock_timeout='5s'");
    await query("SET LOCAL statement_timeout='30s'");
    const selected=await query(`SELECT v.rate_card_version_id,v.revision,v.version_number
      FROM mbt_rate_card_versions v JOIN mbt_rate_cards c USING(rate_card_id)
      WHERE c.rate_card_code=$1 AND c.active AND v.status='active' FOR UPDATE OF c,v`,[cardCode]);
    assert.equal(selected.rowCount,1,'Expected one active MBT delivery rate version');
    const current=selected.rows[0],sourceId=current.rate_card_version_id;
    const before=(await getLocalRateCardGraph(sourceId)).graph;
    const beforeHash=hash(before),beforeMatches=await matches(sourceId);
    assert.equal(before.distanceBands.length,5);
    assert(before.distanceBands.every(b=>b.itemCode==='DELIVERY_CHARGE_MBT' && b.serviceCode==='delivery'));
    if(before.distanceBands.every(b=>b.binTypeCode===null)) {
      assert(beforeMatches.every(row=>row.matches===1));
      return {operation,alreadyConfigured:true,versionId:sourceId,versionNumber:current.version_number,verification:beforeMatches};
    }
    assert(before.distanceBands.every(b=>b.binTypeCode==='14YD'));
    const intended=structuredClone(before);
    intended.distanceBands.forEach(b=>{b.binTypeCode=null;});
    normalizeLocalRateCardGraph(intended,{sourceKind:'manual'});
    const base={operation,authorization:reason,sourceVersionId:sourceId,sourceRevision:current.revision,
      sourceHash:beforeHash,before,intended,beforeMatches};
    if(!process.argv.includes('--apply')) return {...base,planned:true};
    assert.equal(process.argv.find(arg=>arg.startsWith('--expected-hash='))?.split('=')[1],beforeHash,'Rate card changed after planning');
    for(const table of ['mbt_frontdesk_charge_rates','mbt_frontdesk_aggregate_distance_bands']) {
      assert.equal((await query(`SELECT count(*)::int AS n FROM ${table} WHERE rate_card_version_id=$1`,[sourceId])).rows[0].n,0,
        'Associated charge configuration needs an explicit clone plan');
    }
    const cloned=await cloneLocalRateCardVersion(command('clone',{sourceRateCardVersionId:sourceId,expectedRevision:Number(current.revision)}));
    const versionId=cloned.body.version.rateCardVersionId;
    const graph=structuredClone(intended);graph.version.versionNumber=cloned.body.version.versionNumber;
    const replaced=await replaceLocalRateCardDraft(command('replace',{rateCardVersionId:versionId,
      expectedRevision:cloned.body.version.revision,sourceKind:'manual',graph}));
    const validated=await validateLocalRateCardVersion(command('validate',{rateCardVersionId:versionId,expectedRevision:replaced.body.version.revision}));
    const activated=await activateLocalRateCardVersion(command('activate',{rateCardVersionId:versionId,
      expectedRevision:validated.body.version.revision,replacesRateCardVersionId:sourceId}));
    const after=(await getLocalRateCardGraph(versionId)).graph;
    assert.deepEqual(after,graph,'Only the bin scope and version number may change');
    const verification=await matches(versionId);
    assert.equal(verification.length,beforeMatches.length);
    assert(verification.every(row=>row.matches===1),'Every bin, configured yard and distance boundary needs exactly one rate');
    const old=(await getLocalRateCardGraph(sourceId)).graph;
    assert.deepEqual(old.distanceBands,before.distanceBands,'Existing quote rate evidence must remain immutable');
    return {...base,applied:true,versionId,versionNumber:activated.body.version.versionNumber,
      revision:activated.body.version.revision,after,verification,appliedAt:new Date().toISOString()};
  });
  console.log(JSON.stringify(report));
} finally {await closeDb();}
