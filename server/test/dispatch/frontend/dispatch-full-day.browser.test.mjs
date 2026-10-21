import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { chromium, expect } from '@playwright/test';
import { query } from '../../../src/db.js';
import { config } from '../../../src/config.js';
import { replaceDispatchFleetSetup } from '../../../src/dispatch-setup-repository.js';
import { upsertDispatchOrderCatalog } from '../../../src/dispatch-order-catalog-repository.js';
import { createDispatchV2Fixture } from '../support/dispatch-v2-fixture.js';

const day = '2026-10-19';
const artifact = `test-artifacts/full-day-replay/${new Date().toISOString().replaceAll(':', '-')}`;
const refs = Array.from({ length: 5 }, (_, i) => `SO-DAY-${1001 + i}`);

// Compare operational content, excluding browser-only presentation/cache fields.
// This same read-only projection runs against fresh HTTP results and both pages.
function consistencySnapshot(orderList, plan) {
  const sorted = values => values.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  const items = values => sorted((values || []).map(item => ({
    itemId: String(item.itemId || ''), sku: item.sku || '', unit: item.unit || '',
    quantity: Number(item.quantity || 0), pallets: Number(item.pallets || 0),
    poQuantity: Number(item.poAllocatedSalesQty || 0)
  })));
  const order = value => value ? {
    id: value.id, type: value.type, parent: value.originalOrderId || '',
    children: [...(value.childOrders || [])].sort(), items: items(value.items),
    pickups: [...(value.pickupLocations || [])].sort(),
    po: sorted((value.poPickupManifest || []).map(link => ({
      ref: link.poOrderRef, location: link.location, items: items(link.items)
    }))),
    to: sorted((value.orderDependencies || []).map(link => ({
      id: String(link.id), ref: link.transferOrderRef, mode: link.mode,
      lines: sorted((link.lines || []).map(line => ({
        itemId: String(line.itemId), quantity: Number(line.allocatedQuantity || 0)
      })))
    }))),
    co: value.transitCo ? { id: value.transitCo.id, fromYard: value.transitCo.fromYard, toYard: value.transitCo.toYard } : null,
    nested: sorted((value.childOrderDetails || []).map(order))
  } : null;
  return {
    orders: orderList.map(order),
    plan: plan ? {
      id: String(plan.id), revision: Number(plan.revision), digest: plan.digest, status: plan.status,
      trucks: (plan.trucks || []).map(truck => ({ id: truck.id, plate: truck.plate, driverLogin: truck.driverLogin,
        loads: (truck.loads || []).map(load => ({ id: load.id, stops: (load.stops || []).map(stop => ({
          id: stop.id, type: stop.type, orderId: stop.orderId || '',
          orderRefs: [...(stop.orderRefs || [])].sort(), location: stop.location || ''
        })) }))
      }))
    } : null
  };
}

async function seed(fixture) {
  await replaceDispatchFleetSetup({
    drivers: [{ login: 'day-driver', name: 'Replay Driver', license: 'AZ', password: 'isolated-day-driver' }],
    trucks: [{ plate: 'DAY-TRUCK', capacityLbs: 83000, baseYard: '3445' }]
  });
  for (const [i, ref] of refs.entries()) {
    const id = 9530001001 + i;
    await query(`INSERT INTO sales_orders(netsuite_id,tranid,customer,status,status_text,sales_order_type,
      outbound_location_id,outbound_location,dispatch_address,fulfillment_status,netsuite_active)
      VALUES ($1,$2,'Replay Customer','B','Pending Fulfillment','Delivery',1,'3445','30 Replay Road','not_fulfilled',true)`, [id, ref]);
    await query(`INSERT INTO sales_order_lines(sales_order_id,line_id,item_id,item_name,sku,item_type,
      quantity,unit,pallet_qty,to_plt,netsuite_backordered_qty,netsuite_committed_qty,netsuite_active)
      VALUES ($1,1,10374,'REPLAY-ITEM','REPLAY-ITEM','InvtPart',12,'EACH',12,1,12,0,true)`, [id]);
  }
  await query(`INSERT INTO purchase_orders(netsuite_id,tranid,vendor,status,status_text,
    destination_location_id,destination_location,dispatch_vendor_yard,dispatch_address,receipt_status,netsuite_active)
    VALUES (9530002001,'PO-DAY-2001','Replay Vendor','B','Pending Receipt',1,'3445','Replay Vendor','20 Replay Vendor Road','not_received',true)`);
  await query(`INSERT INTO purchase_order_lines(purchase_order_id,line_id,item_id,item_name,sku,item_type,
    quantity,unit,pallet_qty,to_plt,location_id,location,netsuite_active)
    VALUES (9530002001,1,10374,'REPLAY-ITEM','REPLAY-ITEM','InvtPart',36,'EACH',36,1,1,'3445',true)`);
  await query(`INSERT INTO transfer_orders(netsuite_id,tranid,status,status_text,from_location_id,from_location,to_location_id,to_location,netsuite_active)
    VALUES (9530003001,'TO-DAY-3001','B','Pending Fulfillment',28,'2967',1,'3445',true)`);
  for (const stage of ['outbound', 'receiving']) await query(`INSERT INTO transfer_order_lines(transfer_order_id,line_id,item_id,item_name,sku,item_type,
    quantity,unit,pallet_qty,line_stage,netsuite_active) VALUES (9530003001,1,10374,'REPLAY-ITEM','REPLAY-ITEM','InvtPart',24,'EACH',24,$1,true)`, [stage]);
  const all = await fixture.request('/api/dispatch/orders');
  assert.equal(all.response.status, 200, JSON.stringify(all.payload));
  assert.ok(refs.every(ref => all.payload.some(order => order.id === ref)), 'all replay orders enter the real order feed');
  await upsertDispatchOrderCatalog({ orders: all.payload, source: 'isolated-full-day-seed' });
}

test('full dispatch day: real browser actions, persisted saves and a second live session', { timeout: 240000 }, async () => {
  assert.equal(process.env.MBT_TEST_ISOLATED, '1');
  config.dispatch.plannerOrderPoolMode = 'on';
  config.dispatch.plannerCommandMode = 'on';
  config.dispatch.driverOrientedPlanning = true;
  const fixture = await createDispatchV2Fixture();
  let browser, editor, observer;
  const report = { day, artifact, environment: 'isolated synthetic orders; real application HTTP and PostgreSQL',
    slowThresholdMs: 1500, typingDelayMs: 60, timingDefinition: 'Click/navigation waits include the interaction through visible readiness. Typing and drag gesture time are separate; wait starts when input/drop finishes.',
    steps: [], actions: [], browserErrors: [], failedRequests: [], consistencyChecks: [],
    refreshAudit: { navigations: [], manualRefreshClicks: [] },
    consistencyTimingDefinition: 'All consistency times start before the initiating click. Backend acknowledgment is the completed successful HTTP response, an upper bound on commit time. Fresh backend reads then establish the exact expected content; browser times report when matching content is verified, including read/verification overhead. No Save or manual refresh is inserted inside an order-mutation check.' };
  report.runtimeHashes = Object.fromEntries(await Promise.all(['public/dispatch.js', 'src/server.js',
    'src/dispatch-planner-optimization.js', 'src/dispatch-order-catalog-repository.js', 'src/dispatch-sales-resplit-repository.js', 'src/sor-rental-policy.js']
    .map(async file => [file, createHash('sha256').update(await readFile(file)).digest('hex')])));
  const contexts = [];
  let activeAction = '';
  async function action(name, interact, ready = async () => {}, kind = 'click') {
    const row = { number: report.actions.length + 1, phase: report.steps.at(-1)?.name, name, kind, status: 'running' };
    report.actions.push(row); const started = performance.now(); let interacted = started;
    try { activeAction = name; await interact(); interacted = performance.now(); await ready(); row.status = 'passed'; }
    catch (error) { row.status = 'failed'; row.error = error.message; throw error; }
    finally {
      activeAction = '';
      const finished = performance.now(); row.interactionMs = Math.round(interacted - started);
      row.elapsedMs = Math.round(finished - started);
      const wait = finished - (['type', 'drag'].includes(kind) ? interacted : started);
      row.waitMs = Math.round(wait);
      row.slow = wait > report.slowThresholdMs;
      console.log(JSON.stringify({ action: name, waitMs: row.waitMs, elapsedMs: row.elapsedMs, slow: row.slow, status: row.status }));
      await writeFile(`${artifact}/actions.json`, JSON.stringify(report.actions, null, 2));
    }
  }
  const click = (name, locator, ready, options) => action(name, () => locator.click(options), ready);
  const type = (name, locator, value, ready) => action(name, async () => {
    await locator.click(); await locator.press('ControlOrMeta+A'); await locator.press('Backspace');
    await locator.pressSequentially(String(value), { delay: report.typingDelayMs });
  }, ready || (() => expect(locator).toHaveValue(String(value))), 'type');
  const choose = (name, locator, value) => action(name, () => locator.selectOption(value),
    () => typeof value === 'string' ? expect(locator).toHaveValue(value) : Promise.resolve(), 'select');
  const observed = (name, predicate, value) => action(name, async () => {},
    () => observer.waitForFunction(predicate, value, { timeout: 15000 }), 'live-refresh');
  const writeResponse = (method, suffix) => response => response.request().method() === method
    && new URL(response.url()).pathname.endsWith(suffix);
  async function consistent(name, run, { response: matches, orderRefs = [], retiredRefs = [], plan = false }) {
    const started = performance.now();
    const row = { number: report.consistencyChecks.length + 1, phase: report.steps.at(-1)?.name, name, status: 'running' };
    report.consistencyChecks.push(row);
    const navigationCount = report.refreshAudit.navigations.length;
    const acknowledged = editor.waitForResponse(matches, { timeout: 15000 }).then(async response => {
      await response.finished();
      row.backendAcknowledgedMs = Math.round(performance.now() - started);
      row.backendResponse = { method: response.request().method(), path: new URL(response.url()).pathname, status: response.status() };
      assert.ok(response.ok(), `${name}: backend mutation succeeds`);
      return response.json();
    });
    // Attach a handler immediately so a failed click cannot leave an unhandled timeout.
    acknowledged.catch(() => {});
    try {
      await run();
      row.editorActionReadyMs = Math.round(performance.now() - started);
      const payload = await acknowledged;
      const activeRefs = typeof orderRefs === 'function' ? await orderRefs(payload) : orderRefs;
      const absentRefs = typeof retiredRefs === 'function' ? await retiredRefs(payload) : retiredRefs;
      const wantedRefs = [...activeRefs, ...absentRefs];
      const fetched = await Promise.all(wantedRefs.map(ref => fixture.request(`/api/dispatch/v2/order-feed/${encodeURIComponent(ref)}?fresh=true`)));
      for (const [index, result] of fetched.entries()) {
        const retired = absentRefs.includes(wantedRefs[index]);
        assert.equal(result.response.status, retired ? 404 : 200, `${name}: stored identity ${wantedRefs[index]}`);
        if (!retired) assert.equal(result.payload.order.id, wantedRefs[index]);
      }
      let persistedPlan = null;
      if (plan) {
        const id = await editor.evaluate(() => currentPlan.id);
        const result = await fixture.request(`/api/dispatch/plans/${id}`);
        assert.equal(result.response.status, 200); persistedPlan = result.payload;
      }
      // The direct SO feed can omit originalOrderId for materialized splits;
      // the browser derives it from the reference. Read the actual relationship
      // from PostgreSQL instead of treating wire omission as a different parent.
      const backendOrders = fetched.map(result => result.response.status === 404 ? null : result.payload.order);
      const allRefs = values => values.flatMap(order => order ? [order.id, ...allRefs(order.childOrderDetails || [])] : []);
      const parents = new Map((await query(`SELECT split_ref, parent_order_ref FROM dispatch_global_order_splits
        WHERE active AND definition_kind='split' AND split_ref=ANY($1::text[])`, [allRefs(backendOrders)]))
        .rows.map(value => [value.split_ref, value.parent_order_ref]));
      const withStoredParents = order => {
        if (!order) return null;
        const parent = parents.get(order.id);
        if (parent && order.originalOrderId) assert.equal(order.originalOrderId, parent, 'API split parent matches the stored relationship');
        return { ...order, ...(parent ? { originalOrderId: parent } : {}),
          childOrderDetails: (order.childOrderDetails || []).map(withStoredParents) };
      };
      row.expected = consistencySnapshot(backendOrders.map(withStoredParents), persistedPlan);
      row.orderRefs = wantedRefs;
      row.backendVerifiedMs = Math.round(performance.now() - started);
      const expression = `JSON.stringify((${consistencySnapshot.toString()})(
        ${JSON.stringify(wantedRefs)}.map(ref => orderById(ref) || null),
        ${plan ? '{ ...currentPlan, trucks }' : 'null'})) === ${JSON.stringify(JSON.stringify(row.expected))}`;
      await Promise.all([['editor', editor], ['observer', observer]].map(async ([session, page]) => {
        await page.waitForFunction(expression, null, { polling: 50, timeout: 15000 });
        row[`${session}ConsistentByMs`] = Math.round(performance.now() - started);
      }));
      assert.equal(report.refreshAudit.navigations.length, navigationCount, `${name}: no reload to obtain consistency`);
      assert.deepEqual(report.refreshAudit.manualRefreshClicks, [], 'no manual refresh buttons are used');
      row.status = 'passed';
    } catch (error) {
      row.status = 'failed'; row.error = error.stack;
      row.actual = await Promise.all([editor, observer].map(page => page.evaluate(
        `(${consistencySnapshot.toString()})(${JSON.stringify(row.orderRefs || [])}.map(ref => orderById(ref) || null), ${plan ? '{ ...currentPlan, trucks }' : 'null'})`
      ).catch(() => null)));
      throw error;
    } finally {
      row.slow = Math.max(row.editorConsistentByMs || 0, row.observerConsistentByMs || 0) > report.slowThresholdMs;
      console.log(JSON.stringify({ consistency: name, status: row.status, backendAcknowledgedMs: row.backendAcknowledgedMs,
        editorConsistentByMs: row.editorConsistentByMs, observerConsistentByMs: row.observerConsistentByMs, slow: row.slow }));
      await writeFile(`${artifact}/consistency-checks.json`, JSON.stringify(report.consistencyChecks, null, 2));
    }
  }
  const mutationClick = (name, locator, ready, check) => consistent(name, () => click(name, locator, ready), check);
  async function step(name, run) {
    const started = performance.now();
    const row = { name, status: 'running' }; report.steps.push(row);
    try { await run(); row.status = 'passed'; }
    catch (error) { row.status = 'failed'; row.error = error.stack; throw error; }
    finally {
      row.durationMs = Math.round(performance.now() - started);
      if (editor) await editor.screenshot({ path: `${artifact}/${String(report.steps.length).padStart(2, '0')}.png`, fullPage: true }).catch(() => {});
      console.log(JSON.stringify({ step: name, status: row.status, durationMs: row.durationMs }));
      await writeFile(`${artifact}/report.json`, JSON.stringify(report, null, 2));
    }
  }
  async function pageFor(name) {
    const context = await browser.newContext({ viewport: { width: 1600, height: 1050 } });
    contexts.push({ name, context });
    await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
    await context.exposeBinding('recordDispatchManualRefresh', (_source, action) => report.refreshAudit.manualRefreshClicks.push({ session: name, action }));
    await context.addInitScript(() => document.addEventListener('click', event => {
      const action = event.target.closest?.('[data-action]')?.dataset.action || '';
      if (/refresh/u.test(action)) window.recordDispatchManualRefresh(action);
    }, true));
    await context.addInitScript(({ token, day }) => {
      localStorage.setItem('mbbs.staff.token', token);
      localStorage.setItem('mbbs.staff.role', 'dispatcher');
      localStorage.setItem('mbbs.staff.roles', JSON.stringify(['dispatcher']));
      localStorage.setItem('mbbs.dispatch.token', token);
      localStorage.setItem('mbbs.dispatch.planDate', day);
    }, { token: fixture.session.token, day });
    const page = await context.newPage();
    page.on('framenavigated', frame => {
      if (frame === page.mainFrame()) report.refreshAudit.navigations.push({ session: name, action: activeAction, path: new URL(frame.url()).pathname });
    });
    page.on('pageerror', error => report.browserErrors.push({ session: name, message: error.message }));
    page.on('response', response => { if (response.status() >= 400 && response.url().includes('/api/')) report.failedRequests.push({ session: name, status: response.status(), url: response.url() }); });
    page.on('dialog', dialog => dialog.accept());
    page.setDefaultTimeout(10000);
    await action(`Load dispatch page (${name})`, () => page.goto(`${fixture.baseUrl}/dispatch/planning`, { waitUntil: 'domcontentloaded' }), async () => {
      await page.waitForFunction(() => typeof dispatchPlannerSnapshotState !== 'undefined' && dispatchPlannerSnapshotState === 'ready', null, { timeout: 15000 });
      await expect(poolCard(page, refs[0])).toBeVisible();
    }, 'navigate');
    return page;
  }
  const poolCard = (page, ref) => page.locator(`[data-dispatch-order-pool] .order-list [data-order="${ref}"]`);
  async function select(ref) {
    await type(`Search ${ref}`, editor.locator('#orderSearch'), ref, async () => {
      await editor.waitForFunction(() => !orderSearchLoading && !orderSearchTimer);
      await expect(poolCard(editor, ref)).toBeVisible();
    });
    await click(`Select ${ref}`, poolCard(editor, ref), () => editor.waitForFunction(ref => selectedOrderId === ref, ref));
  }
  async function saved() {
    const checkpoint = editor.waitForResponse(response => response.url().includes('/checkpoints') && response.request().method() === 'POST');
    await consistent('Save plan: stored content and both boards agree', () => click('Save plan', editor.locator('[data-action="save-plan-now"]'), async () => {
      const acknowledged = await checkpoint; assert.ok(acknowledged.ok(), 'manual save checkpoint succeeds'); await acknowledged.finished();
      await editor.waitForFunction(() => Boolean(currentPlan?.id) && !localPlanDirty && !saveInFlight && !saveQueued && !pendingPlanSaveAttempt, null, { timeout: 15000 });
      await expect(editor.locator('[data-dispatch-save-status]')).toContainText('Saved');
    }), { response: writeResponse('POST', '/checkpoints'), plan: true });
    const current = await editor.evaluate(() => currentPlan);
    const persisted = await fixture.request(`/api/dispatch/plans/${current.id}`);
    assert.equal(persisted.response.status, 200);
    assert.equal(persisted.payload.digest, current.digest, 'browser and stored plan acknowledge identical content');
    return persisted.payload;
  }
  async function drag(ref, loadIndex = 0) {
    await select(ref);
    const card = poolCard(editor, ref);
    await action(`Hover ${ref} until drag details are ready`, () => card.hover(),
      () => editor.waitForFunction(ref => orderById(ref)?.catalogHydrated !== false, ref), 'hover');
    await consistent(`Autosave drag ${ref}`, () => action(`Drag ${ref} into driver load ${loadIndex + 1}`, () => card.dragTo(editor.locator('[data-load-card] .stop-list').nth(loadIndex)),
      () => editor.waitForFunction(ref => isOrderAssignedInCurrentPlan(ref), ref), 'drag'),
    { response: writeResponse('POST', '/commands'), plan: true });
    await saved();
  }
  async function removeFromLoad(ref) {
    await click(`Remove ${ref} from load`, editor.locator(`[data-load-card] [data-order="${ref}"] [data-action="remove-stop"]`).first(),
      () => editor.waitForFunction(ref => !isOrderAssignedInCurrentPlan(ref), ref));
    await saved();
  }
  async function closeModal() { await click('Close order dialog', editor.locator('.modal-header [data-action="close-modal"]'),
    () => expect(editor.locator('.dispatch-modal')).toHaveCount(0)); }
  async function linkPo(ref, quantity) {
    await select(ref);
    await click(`Open Link PO for ${ref}`, editor.locator('[data-action="open-po-link-modal"]'), () =>
      editor.waitForFunction(() => !poAllocationLoading && (poAllocationOptions?.salesLines?.length || 0) > 0));
    await type('Type PO reference PO-DAY-2001', editor.locator('#poLinkRef'), 'PO-DAY-2001', async () => {
      await expect(editor.locator('[data-po-map-so]').first()).toBeVisible();
      await expect(editor.locator('[data-po-map-po]').first()).toBeVisible();
    });
    const keys = await editor.locator('[data-po-map-so]').evaluateAll(cards => cards.map(card => card.dataset.targetLineKey));
    for (const key of keys) {
      const line = editor.locator(`[data-po-map-so][data-target-line-key="${key}"]`);
      await click(`Choose SO line ${key}`, line, () => expect(line).toHaveAttribute('aria-pressed', 'true'));
      await click('Connect matching PO line', editor.locator('[data-po-map-po]').first(), () => expect(line.locator('..')).toHaveClass(/mapped/u));
    }
    const quantities = editor.locator('[data-po-link-qty="salesQty"]');
    await expect(quantities.first()).toBeEnabled();
    for (const input of await quantities.all()) await type('Enter PO linked quantity', input, quantity);
    await mutationClick(`Link PO to ${ref}`, editor.locator('form[data-form="po-link"] button[type="submit"]'),
      () => expect(editor.locator('.allocation-card')).not.toHaveCount(0),
      { response: writeResponse('POST', '/po-allocations'), orderRefs: [ref] });
    await closeModal(); await saved();
  }
  async function unlinkPo(ref) {
    await select(ref); await click(`Open linked PO for ${ref}`, editor.locator('[data-action="open-po-link-modal"]'),
      () => expect(editor.locator('[data-action="cancel-po-link"]').first()).toBeVisible());
    while (await editor.locator('[data-action="cancel-po-link"]').count()) {
      const button = editor.locator('[data-action="cancel-po-link"]').first();
      const allocation = await button.getAttribute('data-allocation');
      await mutationClick(`Unlink PO allocation ${allocation}`, button, () => expect(editor.locator(`[data-action="cancel-po-link"][data-allocation="${allocation}"]`)).toHaveCount(0),
        { response: writeResponse('DELETE', `/po-allocations/${allocation}`), orderRefs: [ref] });
    }
    await closeModal(); await saved();
  }
  async function split(ref) {
    await select(ref); await click(`Open Split for ${ref}`, editor.locator('[data-action="open-split-modal"]'),
      () => expect(editor.getByRole('heading', { name: 'Split Order', exact: true })).toBeVisible());
    const inputs = editor.locator('[data-split-index="0"]');
    for (const input of await inputs.all()) {
      const unit = await input.getAttribute('data-split-unit');
      const key = await input.getAttribute('data-split-key');
      const first = Number(await input.inputValue());
      const second = editor.locator(`[data-split-key="${key}"][data-split-unit="${unit}"][data-split-index="1"]`);
      const total = first + Number(await second.inputValue());
      await type(`Enter first split ${unit}`, input, total / 2); await type(`Enter second split ${unit}`, second, total / 2);
    }
    const further = ref.endsWith('-S2');
    const root = further ? ref.slice(0, -3) : ref;
    await mutationClick(`Confirm split ${ref}`, editor.locator('[data-action="confirm-split"]'),
      () => expect(editor.getByRole('heading', { name: 'Split Order', exact: true })).toHaveCount(0),
      { response: writeResponse('POST', further ? '/split-orders/resplit' : '/commands'),
        orderRefs: (further ? [1, 3, 4] : [1, 2]).map(index => `${root}-S${index}`), retiredRefs: further ? [ref] : [] });
    await saved();
  }
  try {
    await mkdir(artifact, { recursive: true });
    await seed(fixture);
    browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
    await step('07:00 Open the test day in dispatcher and observer browsers', async () => {
      editor = await pageFor('editor'); observer = await pageFor('observer');
      await expect(editor.locator(`[data-dispatch-order-pool] [data-order="${refs[0]}"]`)).toBeVisible();
      await click('Enter edit mode and acquire lease', editor.locator('[data-action="enter-edit-mode"]'),
        () => expect(editor.locator('[data-action="exit-edit-mode"]')).toBeVisible());
    });
    await step('07:15 Assign a truck and create the first driver load', async () => {
      await choose('Choose driver truck DAY-TRUCK', editor.locator('[data-driver-new-truck="day-driver"]'), { label: 'DAY-TRUCK' });
      await click('Add driver load', editor.locator('[data-action="add-driver-load"][data-driver-login="day-driver"]'),
        () => expect(editor.locator('[data-load-card]')).toHaveCount(1));
      await saved();
      await observed('Observer adopts newly created day plan', () => Boolean(currentPlan?.id) && currentPlan.revision > 0);
    });
    await step('07:30 Link a PO and verify live order details in both browsers', async () => {
      await drag(refs[0]); await removeFromLoad(refs[0]);
      await linkPo(refs[0], 12);
      await observed('Observer receives PO link', ref => (orderById(ref)?.poPickupManifest || []).some(row => row.poOrderRef === 'PO-DAY-2001'), refs[0]);
      const allocated = (await query("SELECT SUM(allocated_sales_qty)::float AS qty FROM dispatch_so_po_allocations WHERE status='active' AND dispatch_target_ref=$1", [refs[0]])).rows[0].qty;
      assert.equal(allocated, 12);
      await drag(refs[0]);
    });
    await step('08:00 Unlink the PO and verify restored yard pickup', async () => {
      await removeFromLoad(refs[0]);
      if (await editor.evaluate(() => isOrderAssignedInCurrentPlan('PO-DAY-2001'))) await removeFromLoad('PO-DAY-2001');
      await unlinkPo(refs[0]);
      await observed('Observer receives PO unlink', ref => (orderById(ref)?.poPickupManifest || []).length === 0, refs[0]);
    });
    await step('08:15 Link a TO, change its mode, and unlink it', async () => {
      await select(refs[2]);
      await click('Open Link TO', editor.locator('[data-action="open-to-link-modal"]'),
        () => editor.waitForFunction(() => !orderDependencyLoading && Boolean(orderDependencyOptions)));
      await type('Type TO reference TO-DAY-3001', editor.locator('#toLinkRef'), 'TO-DAY-3001');
      await click('Match TO lines', editor.locator('[data-action="match-to-link-lines"]'),
        () => expect(editor.locator('[data-to-link-qty="salesQty"]')).toBeVisible());
      await type('Enter TO linked quantity', editor.locator('[data-to-link-qty="salesQty"]'), 6);
      await mutationClick('Link TO', editor.locator('form[data-form="to-link"] button[type="submit"]'),
        () => expect(editor.locator('[data-action="unlink-dependency"]')).toBeVisible(),
        { response: writeResponse('POST', '/order-dependencies'), orderRefs: [refs[2]] });
      await observed('Observer receives TO link', ref => (orderById(ref)?.orderDependencies || []).length === 1, refs[2]);
      await closeModal(); await drag(refs[2]); await removeFromLoad(refs[2]);
      if (await editor.evaluate(() => isOrderAssignedInCurrentPlan('TO-DAY-3001'))) await removeFromLoad('TO-DAY-3001');
      await select(refs[2]); await click('Reopen linked TO', editor.locator('[data-action="open-to-link-modal"]'),
        () => expect(editor.locator('[data-dependency-mode]')).toBeVisible());
      await choose('Choose TO replenishment mode', editor.locator('[data-dependency-mode]'), 'yard_replenishment');
      await mutationClick('Update TO mode', editor.locator('[data-action="update-dependency-mode"]'),
        () => editor.waitForFunction(() => routeNotice === 'Dependency mode updated.' && !orderDependencyLoading),
        { response: writeResponse('PATCH', '/mode'), orderRefs: [refs[2]] });
      await expect.poll(async () => (await query("SELECT dependency_mode FROM order_dependencies WHERE status='active' LIMIT 1")).rows[0]?.dependency_mode).toBe('yard_replenishment');
      await mutationClick('Unlink TO', editor.locator('[data-action="unlink-dependency"]'),
        () => expect(editor.locator('[data-action="unlink-dependency"]')).toHaveCount(0),
        { response: response => response.request().method() === 'DELETE' && new URL(response.url()).pathname.includes('/order-dependencies/'), orderRefs: [refs[2]] });
      await closeModal(); await saved();
      await observed('Observer receives TO unlink', ref => (orderById(ref)?.orderDependencies || []).length === 0, refs[2]);
    });
    await step('09:00 Split an order, then further split its unfinished second part', async () => {
      await split(refs[0]);
      await expect.poll(async () => (await query("SELECT count(*)::int n FROM dispatch_global_order_splits WHERE parent_order_ref=$1 AND active", [refs[0]])).rows[0].n).toBe(2);
      await split(`${refs[0]}-S2`);
      const rows = (await query("SELECT split_ref, full_order FROM dispatch_global_order_splits WHERE parent_order_ref=$1 AND active ORDER BY split_ref", [refs[0]])).rows;
      assert.deepEqual(rows.map(row => row.split_ref), [`${refs[0]}-S1`, `${refs[0]}-S3`, `${refs[0]}-S4`]);
      assert.equal(rows.flatMap(row => row.full_order.items).reduce((sum, item) => sum + Number(item.quantity), 0), 12);
    });
    let groupRef;
    await step('10:00 Group a split with another order and persist the combined load', async () => {
      await type('Search SO-DAY- for grouping', editor.locator('#orderSearch'), 'SO-DAY-', async () => {
        await editor.waitForFunction(() => !orderSearchLoading && !orderSearchTimer);
        await expect(poolCard(editor, `${refs[0]}-S1`)).toBeVisible(); await expect(poolCard(editor, refs[1])).toBeVisible();
      });
      await click('Select first group member', poolCard(editor, `${refs[0]}-S1`),
        () => editor.waitForFunction(ref => selectedOrderId === ref, `${refs[0]}-S1`));
      await click('Ctrl-select second group member', poolCard(editor, refs[1]),
        () => editor.waitForFunction(() => selectedOrderIds.size === 2), { modifiers: ['Control'] });
      await click('Open Group Orders', editor.locator('[data-action="open-group-modal"]'),
        () => expect(editor.getByRole('heading', { name: 'Group Orders', exact: true })).toBeVisible());
      await mutationClick('Confirm group', editor.locator('[data-action="confirm-group"]'),
        () => expect(editor.getByRole('heading', { name: 'Group Orders', exact: true })).toHaveCount(0),
        { response: writeResponse('POST', '/commands'), orderRefs: async () => [await editor.evaluate(() => selectedOrderId)] });
      groupRef = await editor.evaluate(() => selectedOrderId);
      assert.ok(!refs.includes(groupRef) && !groupRef.endsWith('-S1'));
      await saved();
      await observed('Observer receives group members', ({ groupRef, members }) => JSON.stringify(orderById(groupRef)?.childOrders) === JSON.stringify(members),
        { groupRef, members: [`${refs[0]}-S1`, refs[1]] });
    });
    await step('10:30 Link PO quantities to the group and refresh its nested child details', async () => {
      await linkPo(groupRef, 3);
      const rows = (await query("SELECT allocated_sales_qty::float qty FROM dispatch_so_po_allocations WHERE status='active' AND dispatch_target_ref=$1", [groupRef])).rows;
      assert.equal(rows.reduce((sum, row) => sum + row.qty, 0), 6);
      await unlinkPo(groupRef);
    });
    await step('11:00 Ungroup and verify that the retired group disappears in both sessions', async () => {
      await select(groupRef); await mutationClick('Ungroup orders', editor.locator('[data-action="ungroup-order"]'),
        () => editor.waitForFunction(ref => !orderById(ref), groupRef),
        { response: writeResponse('POST', '/commands'), orderRefs: [`${refs[0]}-S1`, refs[1]], retiredRefs: [groupRef] });
      await saved();
      await observed('Observer removes retired group', ref => !orderById(ref), groupRef);
      assert.equal((await query('SELECT active FROM dispatch_global_order_groups WHERE group_ref=$1', [groupRef])).rows[0].active, false);
    });
    await step('11:30 Split and unsplit an untouched order with exact quantity restoration', async () => {
      await split(refs[4]);
      await select(`${refs[4]}-S1`); await mutationClick('Unsplit order', editor.locator('[data-action="unsplit-order"]'),
        () => editor.waitForFunction(ref => Boolean(orderById(ref)) && !orderById(`${ref}-S1`) && !orderById(`${ref}-S2`), refs[4]),
        { response: writeResponse('POST', '/split-orders/unsplit'), orderRefs: [refs[4]], retiredRefs: [`${refs[4]}-S1`, `${refs[4]}-S2`] });
      await saved();
      const restored = await fixture.request(`/api/dispatch/v2/order-feed/${refs[4]}?fresh=true`);
      assert.equal(restored.payload.order.items.reduce((sum, item) => sum + Number(item.quantity), 0), 12);
    });
    let coRef;
    await step('12:00 Create a CO, check its source pickup, then cancel it', async () => {
      await select(refs[3]); await click('Open CO creation', editor.locator('[data-action="open-transit-co"]'),
        () => expect(editor.locator('form[data-form="transit-co"]')).toBeVisible());
      await choose('Choose CO pickup yard', editor.locator('[name="transitFromYard"]'), '3445');
      await choose('Choose CO transit yard', editor.locator('[name="transitToYard"]'), '12441');
      await action('Confirm CO transit move', () => editor.locator('[name="createTransitCo"]').check(),
        () => expect(editor.locator('[name="createTransitCo"]')).toBeChecked());
      await mutationClick('Create CO', editor.locator('form[data-form="transit-co"] button[type="submit"]'),
        () => editor.waitForFunction(ref => Boolean(orderById(ref)?.transitCo?.id), refs[3]),
        { response: writeResponse('POST', '/co-orders'), orderRefs: [refs[3], `CO-${refs[3]}`] });
      coRef = await editor.evaluate(ref => orderById(ref).transitCo.id, refs[3]);
      await observed('Observer receives CO and source pickup', ({ source, coRef }) => orderById(source)?.transitCo?.id === coRef,
        { source: refs[3], coRef });
      if (await editor.locator('.modal-header [data-action="close-modal"]').count()) await closeModal();
      await drag(coRef);
      await choose('Choose truck for the later CO source load', editor.locator('[data-driver-new-truck="day-driver"]'), { label: 'DAY-TRUCK' });
      await click('Add later load after CO transit', editor.locator('[data-action="add-driver-load"][data-driver-login="day-driver"]'),
        () => expect(editor.locator('[data-load-card]')).toHaveCount(2));
      await choose('Inherit start time after the CO load', editor.locator('[data-load-card] [data-load-start-mode]').nth(1), 'auto');
      await saved(); await drag(refs[3], 1);
      await removeFromLoad(refs[3]); await removeFromLoad(coRef);
      await select(refs[3]); await click('Open existing CO', editor.locator('[data-action="open-transit-co"]'),
        () => expect(editor.locator('[data-action="cancel-transit-co"]')).toBeVisible());
      await mutationClick('Cancel CO', editor.locator('[data-action="cancel-transit-co"]'),
        () => editor.waitForFunction(ref => !orderById(ref)?.transitCo, refs[3]),
        { response: writeResponse('DELETE', `/co-orders/${coRef}`), orderRefs: [refs[3]], retiredRefs: [coRef] });
      if (await editor.locator('.modal-header [data-action="close-modal"]').count()) await closeModal();
      await saved();
      await observed('Observer removes cancelled CO', ref => !orderById(ref), coRef);
    });
    await step('13:00 Drag an updated order to the load, undo and redo the placement', async () => {
      await drag(refs[2]);
      await click('Undo order placement', editor.locator('[data-action="undo-plan"]'),
        () => editor.waitForFunction(ref => !isOrderAssignedInCurrentPlan(ref), refs[2]));
      await click('Redo order placement', editor.locator('[data-action="redo-plan"]'),
        () => editor.waitForFunction(ref => isOrderAssignedInCurrentPlan(ref), refs[2]));
      await saved();
    });
    await step('14:00 Reload the editing browser and resume its lease with the saved route', async () => {
      const prior = await saved();
      await action('Reload saved editing session', () => editor.reload({ waitUntil: 'domcontentloaded' }), async () => {
        await expect(editor.locator('[data-action="exit-edit-mode"]')).toBeVisible();
        await editor.waitForFunction(digest => currentPlan?.digest === digest && dispatchPlannerSnapshotState === 'ready', prior.digest);
      }, 'navigate');
      await expect.poll(() => editor.evaluate(ref => isOrderAssignedInCurrentPlan(ref), refs[2])).toBe(true);
    });
    await step('15:00 Add a return load and confirm the day plan', async () => {
      const loadCount = await editor.locator('[data-driver-load-card]').count();
      await click('Add return load', editor.locator('[data-action="add-driver-return"][data-driver-login="day-driver"]'),
        () => expect(editor.locator('[data-driver-load-card]')).toHaveCount(loadCount + 1));
      await saved();
      await mutationClick('Confirm dispatch plan', editor.locator('[data-action="confirm-plan"]'),
        () => editor.waitForFunction(() => currentPlan?.status === 'confirmed', null, { timeout: 20000 }),
        { response: writeResponse('POST', '/confirm'), plan: true });
      await observed('Observer receives confirmed day plan', () => currentPlan?.status === 'confirmed');
    });
    await step('17:00 Reopen the day and verify persisted identities, quantities and export', async () => {
      const planId = await editor.evaluate(() => currentPlan.id);
      let download;
      await action('Export shipped orders CSV', async () => {
        const downloading = editor.waitForEvent('download');
        await editor.locator('[data-action="export-shipped-csv"]').click(); download = await downloading;
      }, async () => { await download.saveAs(`${artifact}/shipped-orders.csv`); assert.equal(await download.failure(), null); });
      await action('Reopen confirmed day', () => editor.reload({ waitUntil: 'domcontentloaded' }),
        () => editor.waitForFunction(() => currentPlan?.status === 'confirmed' && dispatchPlannerSnapshotState === 'ready'), 'navigate');
      assert.equal(await editor.evaluate(ref => Boolean(orderById(ref)), `${refs[0]}-S2`), false);
      assert.equal(await editor.evaluate(ref => Boolean(orderById(ref)), groupRef), false);
      const final = await fixture.request(`/api/dispatch/plans/${planId}`);
      assert.equal(final.payload.digest, await editor.evaluate(() => currentPlan.digest));
      report.plan = { id: planId, status: final.payload.status, revision: final.payload.revision, digest: final.payload.digest };
    });
    assert.deepEqual(report.refreshAudit.manualRefreshClicks, []);
    assert.deepEqual(report.refreshAudit.navigations.map(row => row.action), [
      'Load dispatch page (editor)', 'Load dispatch page (observer)', 'Reload saved editing session', 'Reopen confirmed day'
    ], 'only initial page loads and the two explicit persistence checks navigate');
    assert.ok(report.consistencyChecks.length >= 40, 'all saves and order mutations verify both sessions against storage');
    report.status = 'passed';
    assert.deepEqual(report.browserErrors, []);
  } catch (error) {
    report.status = 'failed'; report.error = error.stack; throw error;
  } finally {
    for (const { name, context } of contexts) await context.tracing.stop({ path: `${artifact}/${name}-trace.zip` }).catch(() => {});
    if (editor) report.finalState = await editor.evaluate(() => ({ plan: currentPlan, notice: routeNotice,
      trucks,
      snapshot: dispatchPlannerSnapshotState, dirty: localPlanDirty, orderRefs: orders.map(order => order.id),
      catalogRefs: orderCatalog.map(order => order.id), evidenceRefs: [...assignedOrderEvidenceById.keys()],
      retiredRefs: [...authoritativeRetiredOrderRefs] })).catch(() => ({}));
    if (observer) report.observerState = await observer.evaluate(() => ({ plan: currentPlan, notice: routeNotice,
      snapshot: dispatchPlannerSnapshotState, dirty: localPlanDirty, orderRefs: orders.map(order => order.id),
      catalogRefs: orderCatalog.map(order => order.id), evidenceRefs: [...assignedOrderEvidenceById.keys()],
      retiredRefs: [...authoritativeRetiredOrderRefs] })).catch(() => ({}));
    report.timingSummary = { actions: report.actions.length, slowActions: report.actions.filter(row => row.slow).length,
      maxWaitMs: Math.max(0, ...report.actions.map(row => row.waitMs)),
      performanceStatus: report.actions.some(row => row.slow) ? 'slow actions observed' : 'all recorded waits within 1.5 seconds' };
    const columns = ['number', 'phase', 'name', 'kind', 'status', 'waitMs', 'interactionMs', 'elapsedMs', 'slow'];
    const csv = [columns, ...report.actions.map(row => columns.map(key => row[key] ?? ''))]
      .map(row => row.map(value => `"${String(value).replaceAll('"', '""')}"`).join(',')).join('\n');
    await writeFile(`${artifact}/action-timings.csv`, csv + '\n');
    await writeFile(`${artifact}/report.json`, JSON.stringify(report, null, 2));
    await writeFile('test-artifacts/full-day-replay/latest.json', JSON.stringify(report, null, 2));
    await browser?.close(); await fixture.close();
  }
});
