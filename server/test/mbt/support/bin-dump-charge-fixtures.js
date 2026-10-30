import crypto from 'node:crypto';
import {query} from '../../../src/db.js';
import {materializeMbtDriverBinJob,startMbtDriverBinJob} from '../../../src/mbt/driver-bin-execution-service.js';
import {driverBinEvent,enabledDriverBinBoundary} from './driver-bin-fixtures.js';
/** @param {Record<string, any>} job */
async function materialize(job) {
  return materializeMbtDriverBinJob(job, {
    clientVersion: "2026.08.03.1",
    minimumClientVersion: "2026.08.03.1"
  });
}

/**
 * @param {Record<string, any>} fixture
 * @param {Record<string, any>} job
 * @param {Record<string, any>} manifest
 * @param {number} sequence
 */
async function start(fixture, job, manifest, sequence) {
  const event = driverBinEvent(fixture, job, "job_started", sequence, {}, {
    manifestId: manifest.manifestId
  });
  return startMbtDriverBinJob(
    { event, job, manifest },
    { capability: enabledDriverBinBoundary }
  );
}

/**
 * @param {Record<string, any>} fixture
 * @param {Record<string, any>} job
 * @param {Record<string, any>} manifest
 * @param {number} sequence
 * @param {Record<string, any>} details
 * @param {Array<{ordinal: number, reference: string, hash?: string}>} [photos]
 */
function completionInput(fixture, job, manifest, sequence, details, photos = []) {
  const event = driverBinEvent(fixture, job, "job_completed", sequence, { mbt: details }, {
    manifestId: manifest.manifestId,
    photos: photos.map((photo) => ({
      photoId: crypto.randomUUID(),
      ordinal: photo.ordinal,
      objectReference: photo.reference,
      sha256: photo.hash || "a".repeat(64),
      mimeType: "image/jpeg",
      byteSize: 2_048,
      durableReceipt: true
    }))
  });
  return {
    event,
    job,
    manifest,
    photoReferences: photos.map((photo) => photo.reference)
  };
}


export {materialize,start,completionInput};
export async function garbageRate(materialId) {
  const cardId=crypto.randomUUID(),versionId=crypto.randomUUID();
  await query(`INSERT INTO mbt_local_item_settings(item_code,display_name,item_type,category,pricing_mode,charge_basis,active,created_by,updated_by)
    VALUES('DUMPGARBAGE','DumpGarbage','dump','dump','rate_card','per_tonne',true,'test','test') ON CONFLICT DO NOTHING`);
  await query(`INSERT INTO mbt_rate_cards(rate_card_id,rate_card_code,display_name,currency,created_by,updated_by)
    VALUES($1,$2,'Garbage per tonne','CAD','test','test')`,[cardId,`GARBAGE_${cardId.replaceAll('-','')}`]);
  await query(`INSERT INTO mbt_rate_card_versions(rate_card_version_id,rate_card_id,version_number,status,effective_from,created_by,updated_by)
    VALUES($1,$2,1,'draft','2020-01-01','test','test')`,[versionId,cardId]);
  await query(`INSERT INTO mbt_dump_tariffs(dump_tariff_id,rate_card_version_id,item_code,material_id,tariff_code,pricing_basis,unit_of_measure,amount_minor,currency)
    VALUES($1,$2,'DUMPGARBAGE',$3,'garbage_tonne','per_weight','TONNE',12000,'CAD')`,[crypto.randomUUID(),versionId,materialId]);
  await query("UPDATE mbt_rate_card_versions SET status='active',activated_at=now() WHERE rate_card_version_id=$1",[versionId]);
  return versionId;
}
