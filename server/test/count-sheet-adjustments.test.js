import test, {before, after} from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {readFile} from 'node:fs/promises';
import fc from 'fast-check';
import {query, closeDb, withTransaction} from '../src/db.js';
import {createOperator, loginOperator} from '../src/auth-repository.js';
import {createCountSheet, getCountSheet, changeCountSheet} from '../src/count-sheet-repository.js';
import {countSheetReconstructionState, reconstructCountSheetComparison} from '../src/count-sheet-reconstruction.js';
import {app} from '../src/server.js';
const ids = [989201201, 989201202];
let op, manager, foreign, server, base;
before(async () => {
  assert.equal(process.env.MBT_TEST_ISOLATED, '1');
  for (const [name, role, yards] of [['op','operator',[1]], ['manager','yard_manager',[1]], ['foreign','yard_manager',[28]]]) {
    const username = crypto.randomUUID(), password = crypto.randomUUID();
    const actor = await createOperator({username, password, displayName:name, role, operatorYardLocationIds:yards, yardLocationIds:yards});
    const session = {actor, ...await loginOperator(username, password)};
    if (name === 'op') {op = session;} else if (name === 'manager') {manager = session;} else {foreign = session;}
  }
  for (const id of ids) {
    await query("INSERT INTO inventory_items(item_id,item_name,item_description,stock_unit,to_pcs) VALUES($1,$2,'Hidden detail','PCS',1) ON CONFLICT DO NOTHING", [id, `Adjust SKU ${id}`]);
    await query('INSERT INTO inventory_balances(item_id,location_id,quantity_on_hand,quantity_available) VALUES($1,1,76.7,76.7) ON CONFLICT DO NOTHING', [id]);
  }
  server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {await new Promise(resolve => server.close(resolve)); await closeDb();});
const manage = (sheet, action, input = {}, actor = manager.actor) => changeCountSheet(actor, sheet.id, action, {revision:sheet.revision, ...input}, {management:true});
const review = sheet => getCountSheet(manager.actor, sheet.id, {management:true});
async function counted(status = 'submitted', itemIds = ids.slice(0, 1)) {
  let s = await createCountSheet(manager.actor, {requestId:crypto.randomUUID(), locationId:1, title:'Adjustment recount', itemIds});
  s = await changeCountSheet(op.actor, s.id, 'take', {});
  for (const itemId of itemIds) {s = await changeCountSheet(op.actor, s.id, 'line', {revision:s.revision, attempt:s.attempt, itemId, values:{pieces:63.95}});}
  if (status === 'submitted') {s = await changeCountSheet(op.actor, s.id, 'submit', {revision:s.revision, attempt:s.attempt});}
  if (status === 'cancelled') {s = await manage(s, 'cancel');}
  return review(s);
}
const adjustments = value => ({adjustments:[{itemId:ids[0], adjusting:value}]});

test('A1/A2: signed adjustments persist, preserve snapshots and use counted minus actual plus adjusting', async () => {
  let s = await counted('in_progress');
  const original = s.items[0].count;
  assert.equal(Number(original.variance), -12.75);
  assert.equal(Number(original.adjusting), 0);
  s = await manage(s, 'adjust', adjustments('-2.75'));
  assert.equal(Number(s.items[0].count.variance), -15.5);
  assert.equal(Number((await review(s)).items[0].count.adjusting), -2.75);
  for (const key of ['quantity','values','conversions','unit','actual_on_hand','system_on_hand','confirmed_at']) {assert.deepEqual(s.items[0].count[key], original[key], key);}
  const blind = await getCountSheet(op.actor, s.id);
  assert.equal('adjusting' in blind.items[0].count, false);
  s = await changeCountSheet(op.actor, s.id, 'line', {revision:s.revision, attempt:s.attempt, itemId:ids[0], values:{pieces:60}});
  s = await review(s);
  assert.equal(Number(s.items[0].count.adjusting), -2.75);
  assert.equal(Number(s.items[0].count.variance), -19.45);
  s = await changeCountSheet(op.actor, s.id, 'submit', {revision:s.revision, attempt:s.attempt});
  s = await manage(s, 'adjust', adjustments('0'));
  assert.equal(Number(s.items[0].count.variance), -16.7);
  assert.equal(Number((await query('SELECT quantity_on_hand FROM inventory_balances WHERE item_id=$1 AND location_id=1', [ids[0]])).rows[0].quantity_on_hand), 76.7);
});

test('A3: invalid batches are rejected atomically without overwriting valid rows', async () => {
  const s = await counted('submitted', ids);
  for (const value of [null, true, {}, [], '', 'NaN', 'Infinity', '1e309', '1e2', '1.2345678', 1000000000001]) {
    await assert.rejects(manage(s, 'adjust', {adjustments:[{itemId:ids[1], adjusting:7}, {itemId:ids[0], adjusting:value}]}), {status:400});
    assert.deepEqual(await review(s), s);
  }
  for (const rows of [[], null, [{itemId:ids[0], adjusting:1}, {itemId:ids[0], adjusting:2}], [{itemId:987654321, adjusting:1}]]) {
    await assert.rejects(manage(s, 'adjust', {adjustments:rows}), {status:400});
    assert.deepEqual(await review(s), s);
  }
  const saved = await manage(s, 'adjust', adjustments(2));
  await assert.rejects(manage(s, 'adjust', adjustments(3)), {status:409});
  assert.deepEqual(await review(s), saved);
});

test('A2: adjustment survives comparison reconstruction with the same formula', async () => {
  let s = await counted();
  s = await manage(s, 'adjust', adjustments(5));
  const state = await countSheetReconstructionState(s.id);
  await reconstructCountSheetComparison({sheetId:s.id, expectedTitle:s.title, expectedFingerprint:state.fingerprint, observedAt:new Date().toISOString(), balances:[{item_id:ids[0], location_id:1, quantity_on_hand:80, quantity_available:80}]});
  s = await review(s);
  assert.equal(Number(s.items[0].count.variance), -11.05);
  assert.equal(Number(s.items[0].count.adjusting), 5);
});

test('A1/A3: generated signed decimal adjustments follow the exact variance equation', async () => {
  let s = await counted();
  await fc.assert(fc.asyncProperty(fc.integer({min:-10000000, max:10000000}), async micro => {
    const value = (micro / 1000000).toFixed(6);
    s = await manage(s, 'adjust', adjustments(value));
    assert.equal(Number(s.items[0].count.adjusting), Number(value));
    assert.equal(Number(s.items[0].count.variance), Number((-12.75 + Number(value)).toFixed(6)));
  }), {seed:20261021, numRuns:30});
});

for (const status of ['in_progress', 'submitted', 'cancelled']) {test(`R1: ${status} recount discards all attempts and preserves the assigned sheet`, async () => {
  let s = await counted(status); const other = await counted();
  await query(`INSERT INTO inventory_count_sheet_counts(sheet_id,attempt,item_id,operator_id,quantity,unit,values,conversions,system_on_hand,system_available,variance)
    SELECT sheet_id,0,item_id,operator_id,quantity,unit,values,conversions,system_on_hand,system_available,variance FROM inventory_count_sheet_counts WHERE sheet_id=$1`, [s.id]);
  const stale = {...s};
  s = await manage(s, status === 'in_progress' ? 'reset' : 'reopen');
  assert.equal(s.id, stale.id); assert.equal(s.title, stale.title); assert.equal(s.location_id, stale.location_id);
  assert.deepEqual(s.items.map(i => i.item_id), stale.items.map(i => i.item_id));
  assert.equal(s.status, 'available'); assert.equal(s.owner_id, null); assert.equal(s.submitted_at, null);
  assert.equal(s.attempt, stale.attempt + 1); assert.equal(s.revision, stale.revision + 1);
  assert.equal(s.counted, 0); assert.deepEqual(s.attempts, []); assert.equal(s.items[0].count, null);
  assert.equal((await query('SELECT * FROM inventory_count_sheet_counts WHERE sheet_id=$1', [s.id])).rowCount, 0);
  assert.ok(s.history.some(e => e.action === (status === 'in_progress' ? 'reset' : 'reopen')));
  assert.deepEqual(await review(other), other);
  await assert.rejects(manage(stale, 'reopen'), {status:409});
  await assert.rejects(manage(stale, 'adjust', adjustments(7)), {status:409});
  s = await changeCountSheet(op.actor, s.id, 'take', {});
  await assert.rejects(changeCountSheet(op.actor, s.id, 'line', {revision:stale.revision, attempt:stale.attempt, itemId:ids[0], values:{pieces:9}}), {status:409});
  await assert.rejects(changeCountSheet(op.actor, s.id, 'submit', {revision:stale.revision, attempt:stale.attempt}), {status:409});
  s = await changeCountSheet(op.actor, s.id, 'line', {revision:s.revision, attempt:s.attempt, itemId:ids[0], values:{pieces:70}});
  s = await changeCountSheet(op.actor, s.id, 'submit', {revision:s.revision, attempt:s.attempt});
  assert.equal(s.status, 'submitted');
  assert.equal(Number((await review(s)).items[0].count.adjusting), 0);
});

}

test('R2: concurrent adjustment and reopen have one winner and no old counts reach the recount', async () => {
  let s = await counted();
  const results = await Promise.allSettled([manage(s, 'adjust', adjustments(1)), manage(s, 'reopen')]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(results.find(r => r.status === 'rejected').reason.status, 409);
  s = await review(s);
  if (s.status === 'submitted') {s = await manage(s, 'reopen');}
  assert.equal(s.counted, 0); assert.deepEqual(s.attempts, []);
});

test('R2: a failed transaction restores deleted records, state and audit', async () => {
  const s = await counted();
  await withTransaction(async () => {
    const reopened = await manage(s, 'reopen');
    assert.equal(reopened.counted, 0);
  }, {rollback:true});
  assert.deepEqual(await review(s), s);
});

test('A2/A3/R2: real HTTP requires session, role, yard, valid state and revision', async () => {
  const s = await counted();
  const post = async (action, session, body) => fetch(`${base}/api/control/count-sheets/${s.id}/${action}`, {method:'POST', headers:{'content-type':'application/json', ...(session ? {authorization:`Bearer ${session.token}`} : {})}, body:JSON.stringify(body)});
  for (const action of ['adjust', 'reopen']) {
    const body = {revision:s.revision, ...adjustments(2)};
    assert.equal((await post(action, null, body)).status, 401);
    assert.equal((await post(action, op, body)).status, 403);
    assert.equal((await post(action, foreign, body)).status, 403);
  }
  const saved = await post('adjust', manager, {revision:s.revision, ...adjustments(2)});
  assert.equal(saved.status, 200);
  const current = await saved.json();
  assert.equal(Number(current.items[0].count.variance), -10.75);
  assert.equal((await post('reopen', manager, {revision:s.revision})).status, 409);
  const reopened = await post('reopen', manager, {revision:current.revision});
  assert.equal(reopened.status, 200);
  const available = await reopened.json();
  await assert.rejects(manage(available, 'adjust', adjustments(1)), {status:409});
  await assert.rejects(manage(available, 'reopen'), {status:409});
  const unfinished = await counted('in_progress', ids);
  await query('DELETE FROM inventory_count_sheet_counts WHERE sheet_id=$1 AND item_id=$2', [unfinished.id, ids[1]]);
  await assert.rejects(manage(unfinished, 'adjust', {adjustments:[{itemId:ids[1], adjusting:1}]}), {status:400});
});

test('M1: historical migration 302 upgrades comparisons and supports rollback without touching counts or snapshots', async () => {
  const s = await counted();
  const sql = await readFile('migrations/302_count_sheet_adjusting.sql', 'utf8');
  await withTransaction(async () => {
    await query('ALTER TABLE inventory_count_sheet_counts DROP COLUMN adjusting');
    await query('UPDATE inventory_count_sheet_counts SET variance=quantity-actual_on_hand WHERE actual_on_hand IS NOT NULL');
    const prior = (await query('SELECT quantity,actual_on_hand,confirmed_at FROM inventory_count_sheet_counts WHERE sheet_id=$1', [s.id])).rows;
    await query(sql);
    const row = (await query('SELECT * FROM inventory_count_sheet_counts WHERE sheet_id=$1', [s.id])).rows[0];
    assert.equal(Number(row.adjusting), 0); assert.equal(Number(row.variance), 12.75);
    assert.deepEqual((await query('SELECT quantity,actual_on_hand,confirmed_at FROM inventory_count_sheet_counts WHERE sheet_id=$1', [s.id])).rows, prior);
  }, {rollback:true});
  assert.deepEqual(await review(s), s);
});

test('M2: corrected variance migration preserves signed adjustments, snapshots and unknown comparisons', async () => {
  const s = await counted('submitted', ids);
  const sql = await readFile('migrations/303_count_sheet_variance.sql', 'utf8');
  await withTransaction(async () => {
    await query(`UPDATE inventory_count_sheet_counts SET adjusting=CASE WHEN item_id=$2 THEN -2.75 ELSE 5 END,
      variance=actual_on_hand-quantity+CASE WHEN item_id=$2 THEN -2.75 ELSE 5 END WHERE sheet_id=$1`, [s.id, ids[0]]);
    await query(`INSERT INTO inventory_count_sheet_counts(sheet_id,attempt,item_id,operator_id,quantity,unit,values,conversions,system_on_hand,system_available,actual_on_hand,variance,adjusting)
      SELECT sheet_id,0,item_id,operator_id,quantity,unit,values,conversions,system_on_hand,system_available,NULL,99,4.5 FROM inventory_count_sheet_counts WHERE sheet_id=$1 AND item_id=$2`, [s.id, ids[0]]);
    const contents = async () => (await query("SELECT to_jsonb(c)-'variance' AS contents FROM inventory_count_sheet_counts c WHERE sheet_id=$1 ORDER BY attempt,item_id", [s.id])).rows;
    const prior = await contents();
    for (let run = 0; run < 2; run++) {
      await query(sql);
      assert.deepEqual(await contents(), prior);
      const rows = (await query('SELECT variance FROM inventory_count_sheet_counts WHERE sheet_id=$1 ORDER BY attempt,item_id', [s.id])).rows;
      assert.deepEqual(rows.map(row => Number(row.variance)), [99, -15.5, -7.75]);
    }
  }, {rollback:true});
  assert.deepEqual(await review(s), s);
});
