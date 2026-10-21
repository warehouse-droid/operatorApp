import assert from 'node:assert/strict';
import test from 'node:test';
import pg from 'pg';
import fc from 'fast-check';
import { returnBalance } from '../../../src/return-policy.js';

const { palletActivityQuery, summarizePalletActivityRows } = await import(
  process.env.PALLET_ACCOUNTING_MODULE || '../../../src/return-netsuite.js'
);
const CUSTOMER = 99092001;
const ITEM = 99092002;

async function ledger(t) {
  assert.equal(process.env.MBT_TEST_ISOLATED, '1');
  assert.equal(new URL(process.env.DATABASE_URL).hostname, 'db');
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  t.after(() => client.end());
  await client.connect();
  await client.query(`
    CREATE TEMP TABLE customer(id bigint PRIMARY KEY);
    CREATE TEMP TABLE transaction(id bigint PRIMARY KEY,entity bigint,type text,status text,
      tranid text,externalid text,trandate date);
    CREATE TEMP TABLE transactionline(transaction bigint,item bigint,quantity numeric,
      mainline text,taxline text,iscogs text,location bigint);
    INSERT INTO customer VALUES (${CUSTOMER}),(${CUSTOMER + 1});
  `);
  let sequence = 0;
  return {
    async clear() {
      await client.query('TRUNCATE transactionline,transaction');
      sequence = 0;
    },
    async movement({ type = 'ItemShip', quantity, mainline = 'F', location = 26,
      customer = CUSTOMER, item = ITEM, status = 'Active', taxline = 'F', mirrors = true }) {
      const id = ++sequence;
      await client.query(`INSERT INTO transaction VALUES ($1,$2,$3,$4,$5,$6,'2026-01-01')`,
        [id, customer, type, status, `SYNTHETIC-${id}`, `synthetic-pallet-${id}`]);
      const signed = type === 'CustCred' ? quantity : -quantity;
      const rows = [{ quantity: signed, mainline, iscogs: 'F' }];
      if (mirrors) {
        rows.push({ quantity: -signed, mainline: 'F', iscogs: 'T' },
          { quantity: signed, mainline: 'F', iscogs: 'T' });
      }
      for (const row of rows) {
        await client.query('INSERT INTO transactionline VALUES ($1,$2,$3,$4,$5,$6,$7)',
          [id, item, row.quantity, row.mainline, taxline, row.iscogs, location]);
      }
      return id;
    },
    async balance() {
      // Translate dialect functions only. Production builds every predicate,
      // join, grouping, aggregate and union exercised by this database query.
      const sql = palletActivityQuery(CUSTOMER, ITEM)
        .replaceAll('NVL(', 'COALESCE(')
        .replaceAll('BUILTIN.DF(t.status)', 't.status');
      const { rows } = await client.query(sql);
      const summary = summarizePalletActivityRows(rows);
      return { ...summary, ...returnBalance(summary) };
    }
  };
}

test('P1 accounting rows and a real main line reconcile 206 issued minus 194 credited to 12', async t => {
  const db = await ledger(t);
  await db.movement({ quantity: 7, mainline: 'T', location: 1 });
  await db.movement({ quantity: 187, location: 1 });
  await db.movement({ quantity: 12, location: 26 });
  await db.movement({ type: 'CustCred', quantity: 194, location: 1 });
  const balance = await db.balance();
  assert.equal(balance.fulfilled, 206);
  assert.equal(balance.netsuiteReturned, 194);
  assert.equal(balance.available, 12);
});

test('P2 the actual seven-pallet fulfillment main line counts once', async t => {
  const db = await ledger(t);
  await db.movement({ quantity: 7, mainline: 'T' });
  const balance = await db.balance();
  assert.equal(balance.fulfilled, 7);
  assert.equal(balance.available, 7);
  assert.equal(balance.fulfillmentTransactionCount, 1);
});

test('P3 fulfillment and credit accounting mirrors do not change movement quantities or identity', async t => {
  const db = await ledger(t);
  await db.movement({ quantity: 5 });
  const credit = await db.movement({ type: 'CustCred', quantity: 2 });
  const balance = await db.balance();
  assert.equal(balance.fulfilled, 5);
  assert.equal(balance.netsuiteReturned, 2);
  assert.equal(balance.available, 3);
  assert.deepEqual(balance.transactionIds, [credit]);
  assert.deepEqual(balance.externalIds, [`synthetic-pallet-${credit}`]);
  assert.equal(balance.creditMemoTransactionCount, 1);
});

test('P4 property: actual quantities are conserved across yards, main lines, accounting rows and order', async t => {
  const db = await ledger(t);
  const movement = fc.record({
    type: fc.constantFrom('ItemShip', 'CustCred'),
    quarters: fc.integer({ min: 1, max: 1000 }),
    mainline: fc.boolean(),
    location: fc.constantFrom(1, 26, 28, 15),
    mirrors: fc.boolean()
  });
  await fc.assert(fc.asyncProperty(fc.array(movement, { minLength: 1, maxLength: 12 }), async inputs => {
    await db.clear();
    let fulfilled = 0;
    let returned = 0;
    for (const input of [...inputs].reverse()) {
      const quantity = input.quarters / 4;
      await db.movement({ ...input, quantity,
        mainline: input.type === 'ItemShip' && input.mainline ? 'T' : 'F' });
      if (input.type === 'ItemShip') {
        fulfilled += quantity;
      } else {
        returned += quantity;
      }
    }
    await db.movement({ quantity: 10000, customer: CUSTOMER + 1, mirrors: false });
    const balance = await db.balance();
    assert.equal(balance.fulfilled, fulfilled);
    assert.equal(balance.netsuiteReturned, returned);
    assert.equal(balance.available, Math.max(fulfilled - returned, 0));
  }), { seed: 800909, numRuns: 80 });
});

test('P5 adversarial: unrelated, tax, inactive and credit header rows never increase entitlement', async t => {
  const db = await ledger(t);
  await db.movement({ quantity: 4, mirrors: false, location: 1 });
  await db.movement({ quantity: 3, mirrors: false, location: 26 });
  await db.movement({ type: 'CustCred', quantity: 2, mirrors: false });
  for (const type of ['ItemShip', 'CustCred']) {
    for (const decoy of [
      { customer: CUSTOMER + 1 }, { item: ITEM + 1 }, { taxline: 'T' },
      { status: 'Voided' }, { status: 'Cancelled' }, { status: 'Rejected' }
    ]) {
      await db.movement({ type, quantity: 1000, mirrors: false, ...decoy });
    }
  }
  await db.movement({ type: 'SalesOrd', quantity: 1000, mirrors: false });
  await db.movement({ type: 'ItemRcpt', quantity: 1000, mirrors: false });
  await db.movement({ type: 'CustCred', quantity: 1000, mainline: 'T', mirrors: false });
  const balance = await db.balance();
  assert.equal(balance.fulfilled, 7);
  assert.equal(balance.netsuiteReturned, 2);
  assert.equal(balance.available, 5);
  assert.equal(balance.fulfillmentTransactionCount, 2);
  assert.equal(balance.creditMemoTransactionCount, 1);
});

test('P6 invalid IDs are rejected before query execution', () => {
  for (const id of [0, -1, 1.5, Infinity, NaN, '1 OR 1=1', '5240; DROP TABLE customer']) {
    assert.throws(() => palletActivityQuery(id, ITEM), { status: 400 });
    assert.throws(() => palletActivityQuery(CUSTOMER, id), { status: 400 });
  }
});
