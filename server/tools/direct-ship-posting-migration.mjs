import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {query,closeDb} from '/app/src/db.js';
try {
 const sql=readFileSync('/workspace/server/migrations/253_direct_ship_netsuite_posting.sql','utf8');
 await query(sql);await query(sql);
 const constraint=(await query("SELECT count(*)::int AS count FROM pg_constraint WHERE conname='operator_posting_actor_or_direct_receipt'")).rows[0];
 assert.equal(constraint.count,1);
 const table=(await query("SELECT to_regclass('dispatch_direct_po_ir_jobs') AS name")).rows[0];assert.ok(table.name);
 const {buildOperatorNetSuitePostingDraft}=await import('/app/src/operator-netsuite-posting-domain.js');
 assert.throws(()=>buildOperatorNetSuitePostingDraft({requestId:'27182026-1001-4000-8000-000000000001',actorOperatorId:null,localOperation:{kind:'receiving_receipt'}}),/Operator ID/u);
 await import('/app/src/server.js');await import('/app/src/operator-netsuite-posting-runtime.js');
 console.log(JSON.stringify({passed:true,migrationAppliedTwice:true,oldSourceImports:true,ordinaryOperatorRequired:true}));
}finally{await closeDb();}
