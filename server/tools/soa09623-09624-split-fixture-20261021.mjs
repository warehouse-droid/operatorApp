// Disposable isolated-db fixture for the operational repair. Inputs are removed by the host retention runner.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {query,withTransaction,closeDb} from '/app/src/db.js';
assert.equal(process.env.MBT_TEST_ISOLATED,'1');
assert.ok(process.env.DATABASE_URL.includes('@db:5432/mbt_test'));
const original=JSON.parse(await fs.readFile('/app/test-artifacts/before.json','utf8'));
const {state}=JSON.parse(await fs.readFile('/app/test-artifacts/preview.json','utf8'));
async function insert(table,records){
  if(!records.length)return;
  const keys=(await query('SELECT column_name FROM information_schema.columns WHERE table_schema=\'public\' AND table_name=$1 ORDER BY ordinal_position',[table])).rows.map(r=>r.column_name);
  const cols=keys.filter(k=>Object.hasOwn(records[0],k));
  await query(`INSERT INTO ${table}(${cols.map(k=>'"'+k+'"').join(',')}) SELECT ${cols.map(k=>'"'+k+'"').join(',')} FROM jsonb_populate_recordset(NULL::${table},$1::jsonb)`,[JSON.stringify(records)]);
}
try{await withTransaction(async()=>{
  await insert('sales_orders',original.orders);
  await insert('sales_order_lines',original.lines);
  await insert('dispatch_plans',[state.plan]);
  await insert('dispatch_plan_snapshots',[{plan_id:366,orders:state.plan.orders,trucks:state.plan.trucks,summary:state.plan.summary,saved_at:state.plan.saved_at}]);
  await insert('dispatch_global_order_groups',original.globalGroups);
  await insert('dispatch_global_order_group_members',original.globalMembers);
  await insert('dispatch_delivery_groups',original.deliveryGroups);
  await insert('dispatch_delivery_group_members',original.deliveryMembers);
  await insert('dispatch_plan_order_assignments',original.assignments);
  await insert('dispatch_order_relation_edges',original.edges);
  await insert('dispatch_plan_load_assignments',original.loadAssignments);
  await insert('operator_load_records',original.operatorLoads.map(r=>({...r,operator_id:null})));
  await query('DELETE FROM dispatch_sales_order_if_candidates WHERE operator_load_record_id=ANY($1::bigint[])',[original.operatorLoads.map(r=>r.id)]);
  await insert('dispatch_sales_order_if_candidates',state.candidates);
  await insert('dispatch_sales_order_if_line_claims',state.claims);
});console.log('Isolated repair fixture ready.');}finally{await closeDb();}
