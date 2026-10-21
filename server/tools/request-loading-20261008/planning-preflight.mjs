/* global indexDefinition */
import {pool,closeDb} from '/app/src/db.js';
pool.options.options='-c jit=off -c default_transaction_read_only=on -c statement_timeout=20000 -c lock_timeout=2000';
try {
 const sql=`SELECT count(*)::int AS plans, count(*) FILTER (WHERE names @> ARRAY['__MBBS_ANY_REFERENCE__'])::int AS conservative_fallback_plans,
 sum(cardinality(names))::int AS indexed_keys FROM dispatch_plan_snapshots
 CROSS JOIN LATERAL (${indexDefinition.replace(/;\s*$/,'')}) reference_keys(names)`;
 const started=Date.now();console.log(JSON.stringify({...(await pool.query(sql)).rows[0],ms:Date.now()-started}));
}finally{await closeDb();}
