import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test, { before, after } from 'node:test';
import pg from 'pg';
import { parseStages } from '../../../public/special-stock-workflow.js';

// Run the production list query against disposable tables on the isolated test DB.
assert.equal(process.env.MBT_TEST_ISOLATED, '1');
assert.equal(new URL(process.env.DATABASE_URL).hostname, 'mbbs-special-review-db');
const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
const source = readFileSync('src/special-stock-request-repository.js', 'utf8');
const start = source.indexOf('export async function listSpecialDispatchHandoffs(');
const end = source.indexOf('\nexport async function requestSpecialCaseClosure(', start);
assert.ok(start >= 0 && end > start);
const helper = name => {
  const from = source.indexOf(`function ${name}(`);
  return source.slice(from, source.indexOf('\nfunction ', from + 1));
};
const list = new Function('query', 'parseStages', 'getSpecialStockCase',
  `${helper('optionalLimit')}\n${helper('cleanSearch')}\n${source.slice(start, end).replace(/^export /, '')}\nreturn listSpecialDispatchHandoffs;`)(
  (sql, params) => client.query(sql, params), parseStages, async id => ({ id: Number(id) }));

before(async () => {
  await client.connect();
  await client.query(`BEGIN;
    CREATE TEMP TABLE sales_special_stock_handoffs(request_id bigint,status text,updated_at timestamptz);
    CREATE TEMP TABLE sales_special_stock_cases(request_id bigint,sales_order_ref text,purchase_order_ref text,purchase_order_netsuite_id bigint);
    CREATE TEMP TABLE special_stock_workflow_stages(request_id bigint,stage text);
    CREATE TEMP TABLE special_stock_purchase_approval(request_id bigint,approved boolean);
    CREATE TEMP TABLE sales_stock_requests(id bigint,request_ref text);
    CREATE TEMP TABLE purchase_orders(netsuite_id bigint,tranid text,dispatch_ref text);
    CREATE TEMP TABLE dispatch_order_completion_status(order_kind text,order_ref text,dispatch_completion_status text);
    INSERT INTO sales_special_stock_handoffs SELECT n,CASE WHEN n=6 THEN 'completed' ELSE 'ready' END,'2026-10-02' FROM generate_series(1,11) n;
    INSERT INTO sales_special_stock_cases SELECT n,'SO'||n,'PO'||n,n FROM generate_series(1,11) n;
    INSERT INTO special_stock_workflow_stages SELECT n,'dispatch_arrangement' FROM generate_series(1,11) n;
    INSERT INTO special_stock_purchase_approval SELECT n,n NOT IN (7,8) FROM generate_series(1,11) n;
    INSERT INTO sales_stock_requests SELECT n,'SPREQ-'||n FROM generate_series(1,11) n;
    INSERT INTO purchase_orders SELECT n,'PO'||n,'SN'||n FROM generate_series(1,11) n;
    INSERT INTO dispatch_order_completion_status VALUES
      ('SO','SO2','completed'),('PO','SN3','completed'),
      ('SO','SO4','completed'),('PO','SN4','completed'),('PO','PO4','completed'),
      ('SO','SO5','completed'),('PO','PO5','completed'),
      ('PO','SN8','completed'),('SO','SO9','completed'),('PO','SN9','pending'),
      ('SO',' so10 ','completed'),('PO',' sn10 ','completed'),('SO','SN11','completed');`);
});
after(async () => { await client.query('ROLLBACK'); await client.end(); });

test('handoff remains with neither or one order completed and hides only completed pairs', async () => {
  assert.deepEqual((await list()).map(row => row.id), [11,9,8,6,3,2,1]);
});

test('completion filtering precedes limits and still respects search and stage filters', async () => {
  assert.deepEqual(await list({ search: 'SPREQ-4' }), []);
  assert.deepEqual(await list({ search: 'SPREQ-8' }), [{ id: 8 }]);
  assert.deepEqual((await list({ limit: 3 })).map(row => row.id), [11,9,8]);
  assert.deepEqual(await list({ stages: 'closed' }), []);
});

test('saved plan projection carries the receiving-yard arrival through the PO dispatch reference', async () => {
  await client.query(`CREATE TEMP TABLE dispatch_plans(id bigint,plan_date date,status text);
    CREATE TEMP TABLE dispatch_plan_snapshots(plan_id bigint,orders jsonb,trucks jsonb);
    INSERT INTO dispatch_plans VALUES(344,'2026-10-02','confirmed');`);
  await client.query('INSERT INTO dispatch_plan_snapshots VALUES(344,$1,$2)', [JSON.stringify([{ id: 'SN1400411', type: 'PO' }]),
    JSON.stringify([{ plate: 'CE94489', loads: [{ name: 'Load 3', stops: [
      { type: 'pick', orderRefs: ['SN1400411'], timing: { arrival: 922 } },
      { type: 'drop', orderId: 'SN1400411', timing: { arrival: 1021 } }
    ] }] }])]);
  const planningSource = readFileSync('src/special-stock-planning.js', 'utf8').replace(/^import .*;\n/gm, '').replace(/^export /gm, '');
  const { read, project } = new Function('query', `${planningSource}\nreturn {read:readSpecialDispatchPlans,project:specialDispatchPlanning};`)((sql, params) => client.query(sql, params));
  const planning = project({ purchaseOrderId: 995310, purchaseOrderRef: 'POB03883', purchaseOrderReference: 'SN1400411' }, await read());
  assert.equal(planning.purchaseOrder.planned, true);
  assert.equal(planning.purchaseOrder.plans[0].estimatedArrivalMinute, 1021);
});
