// User explicitly requested the old flow until they manually enable the toggle.
import assert from 'node:assert/strict';
import {query,closeDb} from './src/db.js';
import {config} from './src/config.js';
import {updateMbtFeatureFlagState,listMbtAdminFeatureFlags} from './src/mbt/feature-flag-repository.js';
import {materializeMbtAdminGates} from './src/mbt/feature-gate-catalog.js';
import {IFIR_POSTING_FLAG_KEY,getIfirPostingRestletEnabled,isIfirPostingDeploymentReady} from './src/netsuite-ifir-posting-policy.js';
import {postIfirViaNetSuiteRestlet} from './src/netsuite.js';
try {
  const before=(await query('SELECT * FROM mbt_feature_flags WHERE flag_key=$1',[IFIR_POSTING_FLAG_KEY])).rows[0];
  assert.ok(before);
  if(before.enabled)await updateMbtFeatureFlagState({actor:{operatorId:'maintenance:ifir-admin-gate-20261021',roles:['admin'],actorType:'system'},
    flagKey:IFIR_POSTING_FLAG_KEY,enabled:false,expectedRevision:Number(before.revision),
    reason:'User requested the old posting flow for now and will turn on the RESTlet flow manually later.',
    idempotencyKey:'ifir-admin-gate-user-disable-20261021',correlationId:'ifir-admin-gate-user-disable-20261021',requestId:'ifir-admin-gate-user-disable-20261021'});
  assert.equal(await getIfirPostingRestletEnabled(),false);
  // Gate-off returns before payload handling, credentials or HTTP. No transaction can be created.
  assert.equal(await postIfirViaNetSuiteRestlet(null),null);
  const gate=materializeMbtAdminGates({flags:await listMbtAdminFeatureFlags(),
    environment:{ifirPostingReady:isIfirPostingDeploymentReady(config.netsuite)}}).find(g=>g.flagKey===IFIR_POSTING_FLAG_KEY);
  console.log(JSON.stringify({at:new Date().toISOString(),gate,effective:false,nativeRoutingVerified:true,netSuitePosts:0}));
}finally{await closeDb();}
