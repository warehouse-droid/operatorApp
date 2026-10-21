import assert from "node:assert/strict";
import crypto from "node:crypto";
import { readFile } from "node:fs/promises";
import { closeDb, query, withTransaction } from "../src/db.js";

// Run on the captured pre-migration runtime using the isolated test database.
const migration = await readFile("/workspace/server/migrations/267_driver_reopen_completion_cycles.sql", "utf8");
const suffix = crypto.randomUUID().slice(0, 8);
const refs = ["pending", "recaptured"].map(label => `TO-MIGRATION-${label}-${suffix}`);
const jobs = refs.map(ref => `migration-job-${ref}`);
try {
  for (const [index, ref] of refs.entries()) {
    const job = (await query(`INSERT INTO driver_job_records(job_id,plan_date,driver_login,stop_id,stop_type,order_refs,status,completed_at)
      VALUES($1,'2001-01-01','migration-driver',$1,'dropoff',$2::jsonb,'complete',clock_timestamp()-interval '1 minute') RETURNING *`, [jobs[index], JSON.stringify([ref])])).rows[0];
    await query("UPDATE driver_job_records SET status='pending',completed_at=NULL WHERE id=$1", [job.id]);
    await query(`INSERT INTO driver_job_corrections(correction_id,idempotency_id,action,driver_job_record_id,job_id,plan_date,driver_login,stop_type,expected_state_hash,audit_note,corrected_by,before_state,after_state,result)
      VALUES($1,$2,'reopen',$3,$4,'2001-01-01','migration-driver','dropoff',$5,'Replan migration fixture','dispatcher',$6::jsonb,'{"status":"pending"}',$7::jsonb)`,
      [crypto.randomUUID(), crypto.randomUUID(), job.id, jobs[index], "a".repeat(64), JSON.stringify({ status: "complete", completedAt: job.completed_at }), JSON.stringify({ physicalVisitJobIds: [jobs[index]] })]);
    if (index === 1) { await query("UPDATE driver_job_records SET status='complete',completed_at=clock_timestamp() WHERE id=$1", [job.id]); }
  }
  const count = async table => Number((await query(`SELECT count(*) FROM ${table} WHERE order_ref=ANY($1::text[])`, [refs])).rows[0].count);
  assert.equal(await count("dispatch_order_completion_events"), 2);
  assert.equal(await count("dispatch_order_completion_status"), 2);
  const oldView = (await query("SELECT pg_get_viewdef('dispatch_effective_order_completion_events'::regclass,true) AS definition")).rows[0].definition;
  const oldIndex = (await query("SELECT indexdef FROM pg_indexes WHERE indexname='idx_dispatch_order_completion_evidence_unique'")).rows[0].indexdef;
  const verify = async () => {
    assert.equal((await query("SELECT 1 FROM dispatch_order_completion_status WHERE order_ref=$1", [refs[0]])).rowCount, 0);
    const recaptured = await query("SELECT c.dispatch_completed_at=j.completed_at AS matches FROM dispatch_order_completion_status c JOIN driver_job_records j ON j.job_id=c.completion_evidence_id WHERE c.order_ref=$1", [refs[1]]);
    assert.equal(recaptured.rows[0]?.matches, true, "migration must retain completion of a stop already recaptured after its reopen");
    assert.equal(await count("dispatch_order_completion_events"), 3);
  };
  await withTransaction(async () => { await query(migration); await verify(); }, { rollback: true });
  assert.equal(await count("dispatch_order_completion_events"), 2);
  assert.equal(await count("dispatch_order_completion_status"), 2);
  assert.equal((await query("SELECT pg_get_viewdef('dispatch_effective_order_completion_events'::regclass,true) AS definition")).rows[0].definition, oldView);
  assert.equal((await query("SELECT indexdef FROM pg_indexes WHERE indexname='idx_dispatch_order_completion_evidence_unique'")).rows[0].indexdef, oldIndex);
  assert.equal((await query("SELECT 1 FROM information_schema.columns WHERE table_name='dispatch_order_completion_events' AND column_name='reopen_correction_id'")).rowCount, 0);
  await query(migration);
  await verify();
  await query(migration);
  await verify();
  console.log(JSON.stringify({ migrationRollback: "passed", historicalPendingReopen: "passed", historicalRecapture: "passed", replayIdempotency: "passed" }));
} finally { await closeDb(); }
