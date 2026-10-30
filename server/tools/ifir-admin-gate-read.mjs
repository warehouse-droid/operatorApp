import {closeDb} from './src/db.js';
import {config} from './src/config.js';
import {listMbtAdminFeatureFlags} from './src/mbt/feature-flag-repository.js';
import {materializeMbtAdminGates} from './src/mbt/feature-gate-catalog.js';
import {IFIR_POSTING_FLAG_KEY,getIfirPostingRestletEnabled,isIfirPostingDeploymentReady} from './src/netsuite-ifir-posting-policy.js';
try {
  const gate=materializeMbtAdminGates({flags:await listMbtAdminFeatureFlags(),
    environment:{ifirPostingReady:isIfirPostingDeploymentReady(config.netsuite)}}).find(g=>g.flagKey===IFIR_POSTING_FLAG_KEY);
  console.log(JSON.stringify({at:new Date().toISOString(),gate,effective:await getIfirPostingRestletEnabled()}));
}finally{await closeDb();}
