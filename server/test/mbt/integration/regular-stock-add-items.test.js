/* global localStorage, window */
import assert from 'node:assert/strict';
import test, {before, after} from 'node:test';
import {randomUUID} from 'node:crypto';
import {chromium, expect} from '@playwright/test';
import {query, closeDb, withTransaction} from '../../../src/db.js';
import {app} from '../../../src/server.js';
import {createOperator} from '../../../src/auth-repository.js';
import {submitRegularStockRequest, decideRegularStockRequest} from '../../../src/regular-stock-request-service.js';
import * as repository from '../../../src/stock-request-repository.js';

const run = randomUUID(), actors = {}, tokens = {};
const itemId = 9800000000861, nextItemId = itemId + 1;
let server, base, browser;
const context = () => ({operatorId: actors.sales, authorizedDestinationLocationIds: [28], allowOverAvailability: true});
const item = (id = nextItemId) => ({itemId: id, sourceLocationId: 1, pieces: 10});
const dependencies = {refreshAvailability: async () => {}, loadPolicies: async () => []};

async function http(path, role = 'sales', body) {
  const response = await fetch(base + path, {method: body ? 'POST' : 'GET',
    headers: {...(role ? {Authorization: `Bearer ${tokens[role]}`} : {}), ...(body ? {'Content-Type': 'application/json'} : {})},
    body: body ? JSON.stringify(body) : undefined});
  return {status: response.status, body: response.headers.get('content-type')?.includes('application/json') ? await response.json() : await response.text()};
}
const add = (request, lines = [item()], role = 'sales', extra = {}) => http(`/api/sales/stock-requests/${request.id}/items`, role,
  {expectedRevision: request.revision, lines, ...extra});
async function fixture(overrides = {}) {
  return submitRegularStockRequest({destinationLocationId: 28, customerName: 'Keep customer', remarks: 'Keep remarks',
    deliveryMethod: 'pickup', lines: [item(itemId)], ...overrides}, context(), dependencies);
}
async function snapshot(id) {
  return {request: (await query('SELECT * FROM sales_stock_requests WHERE id=$1', [id])).rows,
    lines: (await query('SELECT * FROM sales_stock_request_lines WHERE request_id=$1 ORDER BY id', [id])).rows,
    events: (await query('SELECT * FROM sales_stock_request_events WHERE request_id=$1 ORDER BY id', [id])).rows};
}
before(async () => {
  assert.equal(process.env.MBT_TEST_ISOLATED, '1');
  server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  for (const id of [itemId, nextItemId]) {
    await query("INSERT INTO inventory_items(item_id,item_name,stock_unit,to_pcs,to_plt) VALUES($1,$2,'EA',1,100) ON CONFLICT DO NOTHING", [id, `ADD-ITEM-${id}`]);
    await query("INSERT INTO inventory_balances(item_id,location_id,location,quantity_available,quantity_on_hand,synced_at) VALUES($1,1,'3445',10000,10000,now()) ON CONFLICT DO NOTHING", [id]);
  }
  for (const [key, role, yards] of [['sales', 'sales', [28]], ['other', 'sales', [1]], ['driver', 'dispatcher', []]]) {
    const username = `add-item-${key}-${run}`, password = 'Disposable-Add-Item-2026!';
    await createOperator({username, displayName: username, password, role, roles: [role], yardLocationIds: yards});
    actors[key] = (await query('SELECT id FROM operators WHERE username=$1', [username])).rows[0].id;
    const login = await http('/api/auth/login', null, {username, password});
    assert.equal(login.status, 200); tokens[key] = login.body.token;
  }
});
after(async () => {
  await browser?.close();
  if (server) { await new Promise(resolve => server.close(resolve)); }
  await closeDb();
});

test('append preserves material/header evidence and resets an approved request to Pending SCM', async () => {
  const initial = await fixture();
  const approved = await decideRegularStockRequest(initial.id, {expectedRevision: initial.revision,
    decision: 'stock', lineIds: [initial.lines[0].id]}, context(), dependencies);
  const response = await add(approved);
  assert.equal(response.status, 200, JSON.stringify(response.body));
  const saved = response.body;
  assert.equal(saved.lines.length, 2); assert.equal(saved.revision, approved.revision + 1);
  assert.equal(saved.status, 'submitted'); assert.equal(saved.statusSummary.status, 'pending_scm');
  assert.equal(saved.firstScmDecisionAt, null); assert.equal(saved.manualDecisionEventId, 0);
  assert.equal(saved.regular.approvedAt, null); assert.equal(saved.regular.approvalExpiresAt, null);
  assert.equal(saved.regular.approval.automatic, false); assert.equal(saved.regular.customerName, 'Keep customer');
  assert.equal(saved.remarks, initial.remarks); assert.equal(saved.requestRef, initial.requestRef);
  for (const field of ['id', 'itemId', 'itemName', 'salesQty', 'salesUom', 'pallets', 'pieces', 'sourceLocationId', 'destinationLocationId', 'approvalEvidence']) {
    assert.deepEqual(saved.lines[0][field], approved.lines[0][field], field);
  }
  assert(saved.lines.every(line => line.status === 'submitted' && !line.decision && !line.decidedAt));
  const event = saved.events.find(row => row.eventType === 'regular_items_added');
  assert.equal(event.actorId, actors.sales); assert.equal(event.details.previousRevision, approved.revision);
  assert.equal(event.details.previousLines[0].status, 'approved');
  assert((await repository.listSalesStockRequests({...context(), unifiedStatus: 'pending_scm'})).some(row => row.id === saved.id));
});

test('Stocking Transfer and Purchase clear waiting-for-Sales markers while retaining replies', async () => {
  for (const stockingType of ['transfer', 'purchase']) {
    const request = await fixture({deliveryMethod: 'stocking', stockingType});
    const reply = {message: 'Retain conversation'};
    await query('UPDATE sales_stock_requests SET regular_details=regular_details||$2::jsonb WHERE id=$1',
      [request.id, JSON.stringify({reply, replyStatus: 'pending_update', stockingLines: {[request.lines[0].id]: {reply, replyStatus: 'pending_update'}}})]);
    const response = await add(request);
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal(response.body.statusSummary.status, 'pending_scm');
    assert.equal(response.body.regular.replyStatus, null);
    assert.equal(response.body.regular.stockingLines[request.lines[0].id].replyStatus, null);
    assert.deepEqual(response.body.regular.stockingLines[request.lines[0].id].reply, reply);
    assert.equal(response.body.lines[1].stockingType, stockingType);
    if (stockingType === 'purchase') { assert.equal(response.body.lines[1].sourceLocationId, null); }
  }
});

test('invalid input, yard/role bypass and stale revisions leave every row unchanged', async () => {
  const request = await fixture(), before = await snapshot(request.id);
  for (const [role, lines, extra, expected] of [
    [null, [item()], {}, 401], ['driver', [item()], {}, 403], ['other', [item()], {}, 403],
    ['sales', [], {}, 400], ['sales', [item()], {expectedRevision: null}, 400],
    ['sales', [item()], {expectedRevision: request.revision + 1}, 409],
    ['sales', [{...item(), id: request.lines[0].id}], {}, 400],
    ['sales', [{...item(), pieces: -1}], {}, 400], ['sales', [{...item(), sourceLocationId: 28}], {}, 400],
    ['sales', [item(99999999999)], {}, 404], ['sales', [null], {}, 400]
  ]) {
    const response = await add(request, lines, role, extra);
    assert.equal(response.status, expected, JSON.stringify({role, lines, response}));
    assert.deepEqual(await snapshot(request.id), before);
  }
});

test('closed, processed, SO-linked and in-flight requests cannot be reset', async () => {
  for (const changes of [{status: 'completed'}, {status: 'cancelled'}, {regular: {salesOrderId: 123}},
    {regular: {handoffStatus: 'attention'}}, {regular: {pickupTransfer: {status: 'creating'}}},
    {regular: {deliveryVersion: 1}}, {regular: {deliveryMethod: 'waitlist'}}, {lineStatus: 'fulfilled'}]) {
    const request = await fixture();
    if (changes.status) { await query('UPDATE sales_stock_requests SET status=$2 WHERE id=$1', [request.id, changes.status]); }
    if (changes.regular) { await query('UPDATE sales_stock_requests SET regular_details=regular_details||$2::jsonb WHERE id=$1', [request.id, JSON.stringify(changes.regular)]); }
    if (changes.lineStatus) { await query('UPDATE sales_stock_request_lines SET status=$2 WHERE request_id=$1', [request.id, changes.lineStatus]); }
    const before = await snapshot(request.id), response = await add(request);
    assert.equal(response.status, 409, JSON.stringify({changes, response}));
    assert.deepEqual(await snapshot(request.id), before);
  }
});

test('combined line limit is 100 and repeated submissions commit once', async () => {
  const request = await fixture({lines: Array.from({length: 99}, () => item(itemId))});
  const responses = await Promise.all([add(request), add(request)]);
  assert.deepEqual(responses.map(row => row.status).sort(), [200, 409]);
  const saved = responses.find(row => row.status === 200).body;
  assert.equal(saved.lines.length, 100);
  const before = await snapshot(request.id);
  assert.equal((await add(saved)).status, 400); assert.deepEqual(await snapshot(request.id), before);
});

test('combined availability includes existing items and respects the admin override', async () => {
  const request = await fixture({lines: [{...item(itemId), pieces: 9995}]}), before = await snapshot(request.id);
  await assert.rejects(repository.addRegularStockItems(request.id, {expectedRevision: request.revision, lines: [item(itemId)]},
    {...context(), allowOverAvailability: false}), {code: 'STOCK_REQUEST_AVAILABILITY_EXCEEDED'});
  assert.deepEqual(await snapshot(request.id), before);
  const saved = await repository.addRegularStockItems(request.id, {expectedRevision: request.revision, lines: [item(itemId)]}, context());
  assert.equal(saved.lines.reduce((sum, line) => sum + line.salesQty, 0), 10005);
});

test('adding items and an SCM decision serialize on the same revision', async () => {
  assert.equal(typeof repository.addRegularStockItems, 'function');
  for (let index = 0; index < 4; index++) {
    const request = await fixture();
    const append = () => repository.addRegularStockItems(request.id, {expectedRevision: request.revision, lines: [item()]}, context());
    const decide = () => decideRegularStockRequest(request.id, {expectedRevision: request.revision, decision: 'stock', lineIds: [request.lines[0].id]}, context(), dependencies);
    const results = await Promise.allSettled(index % 2 ? [append(), decide()] : [decide(), append()]);
    assert.equal(results.filter(row => row.status === 'fulfilled').length, 1);
    assert.equal(results.find(row => row.status === 'rejected').reason.status, 409);
  }
});

test('a failed insert rolls back additions, the reset, revision and history', async () => {
  assert.equal(typeof repository.addRegularStockItems, 'function');
  const request = await fixture(), before = await snapshot(request.id);
  await withTransaction(async () => {
    await query(`CREATE FUNCTION add_item_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.request_id=${request.id} AND NEW.sales_qty=13 THEN RAISE EXCEPTION 'injected append failure'; END IF; RETURN NEW; END $$`);
    await query('CREATE TRIGGER add_item_fault BEFORE INSERT ON sales_stock_request_lines FOR EACH ROW EXECUTE FUNCTION add_item_fault()');
    await assert.rejects(repository.addRegularStockItems(request.id, {expectedRevision: request.revision, lines: [item(), {...item(), pieces: 13}]}, context()), /injected append failure/);
    assert.deepEqual(await snapshot(request.id), before);
  }, {rollback: true});
});

test('stored transfers, purchase commitments and handoff journals cannot be bypassed', async () => {
  for (const kind of ['transfer', 'purchase', 'handoff']) {
    const request = await fixture(kind === 'purchase' ? {deliveryMethod: 'stocking', stockingType: 'purchase'} : {});
    if (kind === 'transfer') {
      await query("INSERT INTO sales_stock_transfers(request_id,source_location_id,source_name,destination_location_id,destination_name,created_by) VALUES($1,1,'3445',28,'2967',$2)", [request.id, actors.sales]);
    } else if (kind === 'purchase') {
      await query("INSERT INTO regular_stock_purchase_demands(request_line_id,vendor_yard_id,vendor_id,policy_snapshot,requested_quantity,reviewed_quantity,approved_quantity,to_plt,accepted_by) VALUES($1,1,1,'{}',10,10,100,100,$2)", [request.lines[0].id, actors.sales]);
    } else {
      await query("INSERT INTO regular_stock_handoffs(request_id,sales_order_id,sales_order_ref,plan) VALUES($1,$1,$2,'{}')", [request.id, `SO-TEST-${request.id}`]);
    }
    const before = await snapshot(request.id);
    assert.equal((await add(request)).status, 409, kind);
    assert.deepEqual(await snapshot(request.id), before);
  }
  const request = await fixture(), before = await snapshot(request.id);
  await assert.rejects(repository.addRegularStockItems(request.id, {expectedRevision: request.revision, lines: [item()]}, {authorizedDestinationLocationIds: [28]}), {status: 401});
  assert.deepEqual(await snapshot(request.id), before);
});

test('desktop and mobile use the Special Order style, cancel safely and submit with draft recovery', async t => {
  browser = await chromium.launch({args: ['--no-sandbox', '--disable-dev-shm-usage']});
  for (const [width, overrides] of [[1440, {}], [390, {}], [1440, {deliveryMethod: 'stocking', stockingType: 'purchase'}]]) {
    const request = await fixture(overrides);
    const browserContext = await browser.newContext({viewport: {width, height: 1000}, serviceWorkers: 'block'});
    t.after(() => browserContext.close());
    await browserContext.addInitScript(({token, id}) => {
      localStorage.setItem('mbbs.staff.token', token);
      localStorage.setItem('mbbs.sales.stockRequests.selected', String(id));
      localStorage.setItem('mbbs.appSidebar.collapsed', 'true');
      window.EventSource = class {addEventListener() {} removeEventListener() {} close() {}};
    }, {token: tokens.sales, id: request.id});
    const page = await browserContext.newPage(), errors = [];
    page.setDefaultTimeout(10000);
    await page.route('**/availability/refresh', async route => route.fulfill({json: await repository.getStockRequestItemAvailability(nextItemId)}));
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(base + '/sales/stock-requests?tab=regular');
    const button = page.getByRole('button', {name: 'Add item', exact: true});
    await expect(button).toBeVisible();
    await expect(button).toHaveCSS('background-color', 'rgb(124, 58, 237)');
    await button.click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toContainText('Pending SCM');
    await dialog.getByRole('button', {name: 'Cancel', exact: true}).click();
    await expect(dialog).toHaveCount(0);
    assert.equal((await snapshot(request.id)).lines.length, 1);
    await button.click(); await expect(dialog).toBeVisible(); await page.keyboard.press('Escape'); await expect(dialog).toHaveCount(0);
    await button.click(); await dialog.getByRole('button', {name: 'Continue', exact: true}).click();
    await page.getByRole('button', {name: 'Add another item', exact: true}).click();
    await expect(page.locator('[data-sales-stock-line]')).toHaveCount(2);
    await page.locator('[data-sales-stock-action="remove-line"]').last().click();
    await expect(page.locator('[data-sales-stock-line]')).toHaveCount(1);
    await page.locator('[data-sales-stock-field="itemSearch"]').fill(`ADD-ITEM-${nextItemId}`);
    await page.locator('[data-sales-stock-action="choose-item"]').click();
    await page.locator('[data-sales-stock-field="pieces"]').fill('10');
    const submit = page.getByRole('button', {name: 'Submit new items to SCM', exact: true});
    await page.route(`**/api/sales/stock-requests/${request.id}/items`, route => route.fulfill({status: 503, json: {error: 'Temporary save failure'}}), {times: 1});
    await submit.click(); await expect(page.locator('[data-sales-stock-field="pieces"]')).toHaveValue('10');
    await expect(page.locator('[data-sales-stock-field="itemSearch"]')).toHaveValue(`ADD-ITEM-${nextItemId}`);
    await submit.click(); await expect(page.locator('[data-sales-stock-form]')).toHaveCount(0);
    await expect(page.locator('.stock-request-detail')).toContainText('Pending SCM');
    assert.equal((await snapshot(request.id)).lines.length, 2); assert.deepEqual(errors, []);
    await browserContext.close();
  }
});
