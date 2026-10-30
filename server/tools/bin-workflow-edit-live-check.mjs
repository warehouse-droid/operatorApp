// Run inside the application container; all database access is read-only.
import assert from 'node:assert/strict';
import {query,withTransaction,closeDb} from '/app/src/db.js';
import {getBinOrderWorkflowOptions} from '/app/src/mbt/bin-order-workflow-service.js';
try {
  const result=await withTransaction(async()=>{
    await query('SET TRANSACTION READ ONLY');
    const options=await getBinOrderWorkflowOptions('bd1f5b52-ff68-4d46-b1c0-a16c6b292630');
    const parts=options.workflow.parts.map(p=>({reference:p.reference,role:p.role,status:p.status,planId:p.planId,revision:p.revision}));
    if(parts.every(p=>!p.planId&&['ready','tentative'].includes(p.status))) {
      assert.deepEqual([options.editability.sequence,options.editability.delivery,options.editability.collection],[true,true,true]);
      assert.equal(options.configurationIssue,null);
    }
    return {reference:options.workflow.reference,editability:options.editability,configurationIssue:options.configurationIssue,parts,
      linkedTargetSelectable:options.targets.some(t=>t.order_id==='a0b21252-4d4c-4058-889c-95ddc6de96be')};
  });
  console.log(JSON.stringify(result,null,2));
} finally {await closeDb();}
