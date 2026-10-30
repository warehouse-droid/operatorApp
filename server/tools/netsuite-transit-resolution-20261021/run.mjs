// Dated maintenance entry point. Calls the normal deployed reconciliation flow.
// This service reads NetSuite and updates local accounting/status projections.
import assert from 'node:assert/strict';
import {closeDb} from './src/db.js';
import {startScmReconciliationRun,applyScmReconciliationRun} from './src/scm-reconciliation-service.js';
import {getScmReconciliationRunDetails} from './src/scm-reconciliation-repository.js';
import {getIfirPostingRestletEnabled} from './src/netsuite-ifir-posting-policy.js';
const actor='maintenance:netsuite-transit-resolution-20261021';
const emit=value=>console.log(JSON.stringify({at:new Date().toISOString(),...value}));
try {
  assert.equal(await getIfirPostingRestletEnabled(),false,'The user selected the old posting flow.');
  if(MODE==='propose') {
    for(const kind of ['TO','PO']) {
      emit({event:'start-proposal',kind,refs:TARGETS[kind]});
      const run=await startScmReconciliationRun({scope:'order_family',targetOrderKind:kind,
        targetOrderRefs:TARGETS[kind],includeTerminalOrders:true,dryRun:true,requestedBy:actor});
      const details=await getScmReconciliationRunDetails(run.id,{limit:200});
      emit({event:'proposal',kind,run,details});
      assert.equal(run.status,'succeeded','Proposal must finish before continuing.');
    }
  } else {
    for(const proposal of PROPOSALS) {
      if(proposal.details.targets.some(t=>t.status==='review')) {
        emit({event:'deferred-review',kind:proposal.kind,proposalRunId:proposal.run.id,
          reason:'Review separately using exact existing receipt evidence; do not force-accept allocation conflicts.'});
        continue;
      }
      assert.ok(proposal.details.targets.every(t=>t.status==='succeeded'
        &&t.proposedChange.applicationStatus==='Completed'&&!t.proposedChange.reason));
      emit({event:'start-apply',kind:proposal.kind,proposalRunId:proposal.run.id});
      const result=await applyScmReconciliationRun(proposal.run.id,actor);
      const details=await getScmReconciliationRunDetails(result.applyRun.id,{limit:200});
      emit({event:'applied',kind:proposal.kind,result,details});
      assert.equal(result.applied,true,'Application must succeed before continuing.');
    }
  }
  assert.equal(await getIfirPostingRestletEnabled(),false);
} finally {await closeDb();}
