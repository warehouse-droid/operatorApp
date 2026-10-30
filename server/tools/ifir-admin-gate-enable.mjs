// Authorized deployment activation, using the same revision/audit command as Admin.
import assert from 'node:assert/strict';
import {query,closeDb} from './src/db.js';
import {config} from './src/config.js';
import {updateMbtFeatureFlagState,listMbtAdminFeatureFlags} from './src/mbt/feature-flag-repository.js';
import {materializeMbtAdminGates} from './src/mbt/feature-gate-catalog.js';
import {IFIR_POSTING_FLAG_KEY,getIfirPostingRestletEnabled,isIfirPostingDeploymentReady} from './src/netsuite-ifir-posting-policy.js';
try {
  const before=(await query('SELECT * FROM mbt_feature_flags WHERE flag_key=$1',[IFIR_POSTING_FLAG_KEY])).rows[0];
  assert.ok(before);assert.ok(isIfirPostingDeploymentReady(config.netsuite));
  if(!before.enabled) {
    await updateMbtFeatureFlagState({actor:{operatorId:'maintenance:ifir-admin-gate-20261021',roles:['admin'],actorType:'system'},
      flagKey:IFIR_POSTING_FLAG_KEY,enabled:true,expectedRevision:Number(before.revision),
      reason:'User authorized enabling the deployed IR/IF RESTlet flow and retaining the original flow behind an Admin feature gate.',
      idempotencyKey:'ifir-admin-gate-activation-20261021',correlationId:'ifir-admin-gate-20261021',requestId:'ifir-admin-gate-20261021'});
  }
  const gate=materializeMbtAdminGates({flags:await listMbtAdminFeatureFlags(),
    environment:{ifirPostingReady:isIfirPostingDeploymentReady(config.netsuite)}}).find(g=>g.flagKey===IFIR_POSTING_FLAG_KEY);
  console.log(JSON.stringify({at:new Date().toISOString(),gate,effective:await getIfirPostingRestletEnabled()}));
}finally{await closeDb();}
