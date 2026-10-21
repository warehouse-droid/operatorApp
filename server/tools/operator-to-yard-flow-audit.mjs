// Read-only operational snapshot; no NetSuite request or posting is made here.
import { query, withTransaction, closeDb } from '../src/db.js';

try {
  const result = await withTransaction(async () => {
    await query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const select = async (sql) => (await query(sql)).rows;
    return {
      at: new Date().toISOString(),
      orders: await select('SELECT * FROM transfer_orders ORDER BY netsuite_id'),
      lines: await select('SELECT * FROM transfer_order_lines ORDER BY transfer_order_id,line_stage,id'),
      loads: await select(`SELECT to_jsonb(record)-'photo_data_url'-'photo_data_urls' AS record
        FROM operator_load_records record JOIN transfer_orders o ON o.netsuite_id=record.order_id
        WHERE record.order_family='transfer_order' ORDER BY record.id`),
      receipts: await select(`SELECT to_jsonb(record)-'photo_data_urls' AS record
        FROM receiving_receipt_records record JOIN transfer_orders o ON o.netsuite_id=record.order_id ORDER BY record.id`),
      jobs: await select('SELECT * FROM transfer_order_posting_jobs ORDER BY local_to_id,transaction_type,created_at'),
      commands: await select(`SELECT c.* FROM operator_netsuite_posting_commands c
        WHERE EXISTS(SELECT 1 FROM operator_netsuite_posting_steps s WHERE s.command_id=c.id AND s.source_order_kind='TO') ORDER BY c.created_at`),
      steps: await select(`SELECT * FROM operator_netsuite_posting_steps WHERE source_order_kind='TO' ORDER BY command_id,step_index`),
      assignments: await select(`SELECT a.*,p.status AS plan_status FROM dispatch_plan_order_assignments a
        JOIN dispatch_plans p ON p.id=a.plan_id WHERE EXISTS(SELECT 1 FROM transfer_orders o WHERE upper(o.tranid)=upper(a.order_ref)) ORDER BY a.plan_date,a.plan_id,a.order_ref`),
      completions: await select(`SELECT e.*,d.status AS driver_status,d.stop_type,d.completed_at,d.mbt_assignment_withdrawn_at
        FROM dispatch_effective_order_completion_events e LEFT JOIN driver_job_records d ON d.job_id=e.completion_evidence_id
          AND d.plan_id IS NOT DISTINCT FROM e.plan_id AND d.load_id=e.load_id AND d.plan_date IS NOT DISTINCT FROM e.plan_date
        WHERE e.order_kind='TO' ORDER BY e.id`),
      dependencies: await select(`SELECT d.* FROM order_dependencies d WHERE d.transfer_order_id IS NOT NULL ORDER BY d.id`),
      columns: await select(`SELECT table_name,column_name,data_type FROM information_schema.columns
        WHERE table_schema='public' AND table_name IN ('operator_load_records','receiving_receipt_records',
          'transfer_orders','transfer_order_lines','transfer_order_posting_jobs','operator_netsuite_posting_steps') ORDER BY table_name,ordinal_position`)
    };
  });
  console.log(JSON.stringify(result));
} finally {
  await closeDb();
}
