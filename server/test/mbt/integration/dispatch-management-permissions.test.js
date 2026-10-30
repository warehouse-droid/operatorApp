import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {query,closeDb} from '../../../src/db.js';
import {config} from '../../../src/config.js';
import {previewRateCardCsvImport,applyRateCardCsvImport} from '../../../src/mbt/rate-card-csv-import-service.js';
import {validateLocalRateCardVersion,activateLocalRateCardVersion,getLocalRateCardGraph,replaceLocalRateCardDraft} from '../../../src/mbt/rate-card-configuration-service.js';
import {buildRateCardCsvFiles} from '../support/rate-card-csv-import-fixtures.js';
import {previewMbtBinAssetCsvImport} from '../../../src/mbt/asset-csv-import-service.js';
import {buildAssetCsvFile} from '../support/asset-csv-import-fixtures.js';
import {getFrontdeskCustomerChargeAdminConfiguration} from '../../../src/mbt/customer-charge-request-service.js';
after(closeDb);
const actor={operatorId:'dispatch-rate-manager',roles:['dispatcher']};
function command(extra={}) {return {actor,reason:'Dispatch manages the local rate card',idempotencyKey:crypto.randomUUID(),correlationId:crypto.randomUUID(),requestId:crypto.randomUUID(),...extra};}

test('Dispatch management: real rate CSV, validation, activation and immutable-used-rate guard',async()=>{
  config.mbt.enabled=true;config.mbtPhase3.masterDataEnabled=true;config.mbtPhase3.assetManagementEnabled=true;
  await query("UPDATE mbt_feature_flags SET enabled=true WHERE flag_key IN ('mbt_enabled','mbt_master_data','mbt_asset_management')");
  const preview=await previewRateCardCsvImport(command({files:buildRateCardCsvFiles({suffix:crypto.randomUUID(),minimal:true})}));
  assert.equal(preview.status,'previewed');
  const applied=await applyRateCardCsvImport(command({batchId:preview.batchId,normalizedHash:preview.normalizedHash,targetRevisionToken:preview.targetRevisionToken}));
  const id=applied.body.version.rateCardVersionId;
  assert.ok(id,JSON.stringify(applied.body));
  let graph=await getLocalRateCardGraph(id);
  const revision=()=>graph.version?.revision ?? graph.rateCardVersion?.revision ?? graph.revision;
  await validateLocalRateCardVersion(command({rateCardVersionId:id,expectedRevision:revision()}));
  graph=await getLocalRateCardGraph(id);
  await activateLocalRateCardVersion(command({rateCardVersionId:id,expectedRevision:revision()}));
  graph=await getLocalRateCardGraph(id);
  await assert.rejects(replaceLocalRateCardDraft(command({rateCardVersionId:id,expectedRevision:revision(),sourceKind:'manual',graph:graph.graph || graph})),e=>e.code==='MBT_RATE_CARD_EDIT_REQUIRES_CLONE');
  await getFrontdeskCustomerChargeAdminConfiguration({actor,rateCardVersionId:id});
  const file=buildAssetCsvFile({suffix:crypto.randomUUID().slice(0,8)});
  const assets=await previewMbtBinAssetCsvImport(command(file));
  assert.ok(assets.batchId);
  await assert.rejects(previewRateCardCsvImport(command({actor:{operatorId:'sales',roles:['mbt_frontdesk']},files:[]})),e=>e.status===403);
});
