import { query, withTransaction, closeDb } from './src/db.js';
import { previewScmDependencyMutation } from './src/scm-dependency-preview-service.js';
import { config } from './src/config.js';
config.netsuite.directAccessEnabled = false;
const pattern = '^SOM06964(-S[0-9]+)*$';
try {
  const result = await withTransaction(async () => {
    await query('SET TRANSACTION READ ONLY');
    await query("SET LOCAL statement_timeout='30s'");
    const rows = async (sql,args=[]) => (await query(sql,args)).rows;
    const headers = await rows('SELECT * FROM sales_orders WHERE tranid ~ $1 ORDER BY netsuite_id',[pattern]);
    const ids = headers.map(row=>row.netsuite_id);
    const lines = await rows('SELECT * FROM sales_order_lines WHERE sales_order_id=ANY($1::bigint[]) ORDER BY sales_order_id,id',[ids]);
    const definitions = await rows('SELECT * FROM dispatch_global_order_splits WHERE parent_order_ref=$1 OR split_ref ~ $2 ORDER BY split_ref',['SOM06964',pattern]);
    const nativeSplits = await rows('SELECT * FROM dispatch_scm_so_splits WHERE source_so_ref=$1 OR split_so_ref ~ $2 ORDER BY split_so_ref',['SOM06964',pattern]);
    const allocations = await rows("SELECT * FROM dispatch_so_po_allocations WHERE status='active' AND (sales_order_ref ~ $1 OR dispatch_target_ref ~ $1 OR sales_order_id=ANY($2::bigint[])) ORDER BY id",[pattern,ids]);
    const dependencies = await rows("SELECT * FROM order_dependencies WHERE status='active' AND (sales_order_ref ~ $1 OR dispatch_target_ref ~ $1) ORDER BY id",[pattern]);
    const assignments = await rows('SELECT * FROM dispatch_plan_order_assignments WHERE order_ref ~ $1 OR planned_order_ref ~ $1',[pattern]);
    const plans = await rows(`SELECT p.id,p.plan_date::text,p.revision,p.status,p.note,s.orders,s.trucks,s.summary,s.saved_at
      FROM dispatch_plans p JOIN dispatch_plan_snapshots s ON s.plan_id=p.id
      WHERE s.orders::text LIKE '%SOM06964%' ORDER BY p.plan_date DESC,p.id DESC`);
    const groups = await rows(`SELECT g.* FROM dispatch_global_order_groups g WHERE g.active AND EXISTS
      (SELECT 1 FROM dispatch_global_order_group_members m WHERE m.group_ref=g.group_ref AND m.member_order_ref ~ $1)`,[pattern]);
    const driver = await rows("SELECT id,order_refs,status,started_at,completed_at FROM driver_job_records WHERE order_refs::text LIKE '%SOM06964%' ORDER BY created_at DESC LIMIT 20");
    const actor = (await rows("SELECT id,username,role,roles,active,yard_location_ids FROM operators WHERE lower(username)='testadmin'"))[0];
    const previews = [];
    for (const allocation of allocations) {
      try { previews.push({id:allocation.id,preview:await previewScmDependencyMutation({action:'unlink_po',payload:{allocationId:Number(allocation.id)}},{id:actor?.id,sessionId:'codex:SOM06964:unsplit:20261015',surface:'dispatch'})}); }
      catch(error) { previews.push({id:allocation.id,error:{code:error.code,message:error.message}}); }
    }
    return {at:new Date().toISOString(),readOnly:true,actor,headers,lines,definitions,nativeSplits,allocations,dependencies,assignments,plans,groups,driver,previews};
  });
  console.log(JSON.stringify(result,null,2));
} finally { await closeDb(); }
