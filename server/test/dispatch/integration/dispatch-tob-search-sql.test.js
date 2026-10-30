import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import fc from 'fast-check';
import { query, beginRollbackContext, closeDb } from '../../../src/db.js';
import { netSuiteClosedOrderFamilySql } from '../../../src/netsuite-closed-order-policy.js';
import { DISPATCH_CLOSED_ORDER_FAMILY_CTES } from '../../../src/dispatch-order-pool-sql.js';

after(closeDb);
test('search SQL properties: materialized closure exactly preserves original SO/PO/TO family rules', async () => {
  const rollback = await beginRollbackContext();
  try { await rollback.run(async () => {
    const definitions = [['so', 'sales_orders'], ['po', 'purchase_orders'], ['to', 'transfer_orders']];
    for (const [kind, table] of definitions) {
      await query(`CREATE TEMP TABLE ${table}(netsuite_id bigint PRIMARY KEY,status text,status_text text) ON COMMIT DROP`);
      await query(`CREATE TEMP TABLE dispatch_scm_${kind}_splits(source_${kind}_id bigint,split_${kind}_id bigint,status text) ON COMMIT DROP`);
    }
    const statuses = ['Pending Fulfillment', 'Closed', 'Rejected', 'Sales Order : Closed', 'Purchase Order:Rejected',
      'Transfer   Order :  Closed', 'Not Closed', 'Billed', 'Received', null];
    await fc.assert(fc.asyncProperty(
      fc.array(fc.record({ code: fc.constantFrom('B', 'H', null), label: fc.constantFrom(...statuses) }), { minLength: 30, maxLength: 30 }),
      fc.array(fc.tuple(fc.option(fc.integer({ min: 1, max: 30 }), { nil: null }), fc.option(fc.integer({ min: 1, max: 35 }), { nil: null })), { minLength: 5, maxLength: 45 }),
      async (orders, relations) => {
        for (const [kind, table] of definitions) {
          await query(`TRUNCATE ${table}, dispatch_scm_${kind}_splits`);
          await query(`INSERT INTO ${table} SELECT (ordinality)::bigint, row->>'code', row->>'label'
            FROM jsonb_array_elements($1::jsonb) WITH ORDINALITY AS input(row,ordinality)`, [JSON.stringify(orders)]);
          await query(`INSERT INTO dispatch_scm_${kind}_splits SELECT (row->>0)::bigint,(row->>1)::bigint,'cancelled'
            FROM jsonb_array_elements($1::jsonb) AS input(row)`, [JSON.stringify(relations)]);
        }
        for (const [kind, table] of definitions) {
          const rows = (await query(`WITH ${DISPATCH_CLOSED_ORDER_FAMILY_CTES}
            SELECT candidate.netsuite_id, ${netSuiteClosedOrderFamilySql('candidate', kind.toUpperCase())} AS expected,
              candidate.netsuite_id IN (SELECT id FROM closed_${kind}_ids) AS actual
            FROM ${table} candidate ORDER BY candidate.netsuite_id`)).rows;
          for (const row of rows) assert.equal(row.actual, row.expected, `${kind}:${row.netsuite_id}`);
        }
      }
    ), { seed: 20261028, numRuns: 40 });
  }); } finally { await rollback.rollback(); }
});
