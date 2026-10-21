import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { chromium } from "playwright";
import { installKeyboardViewport, checkPhoneKeypad, checkPhoneKeyboardScroll, assertInputFonts, checkInputPreferences } from "./operator-phone-keyboard.checks.mjs";

const artifacts = process.env.PHONE_TEST_ARTIFACTS || "test-artifacts/operator-phone-20261008";
const results = [];
const errors = [];
const iphone = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1";
const android = "Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 Chrome/151.0.0.0 Mobile Safari/537.36";
const tablet = "Mozilla/5.0 (Linux; Android 14; Tablet) AppleWebKit/537.36 Chrome/151.0.0.0 Safari/537.36";
const sku = { item_id: 42, item_name: "STONE-240 · Natural stone", item_description: "Natural stone pavers, grey, 240 × 120 mm. Handle with care.", product_type: "Pavers", brand: "Yard Stone", series: "Classic", to_pcs: 1, to_plt: 24, to_lyr: 6, stock_unit: "PCS", sales_unit: "PCS" };
const sheet = { id: "sheet-phone", title: "Yard 3445 · Weekly count sheet", owner_id: "phone-check", status: "in_progress", counted: 0, total: 3, revision: 1, attempt: 1, items: [sku, { ...sku, item_id: 43 }, { ...sku, item_id: 44 }] };
const report = { id: "damage-phone", ...sku, status: "posted", quantity: 6, unit: "PCS", values: { pieces: 6 }, photos: [], reason_label: "Broken in yard", operator_name: "Phone operator", created_at: "2026-10-08T12:00:00Z", transfer_ref: "IT-TEST-001" };
const allScenes = [
  "menu", "inventory", "delivery-select", "return-select", "customer-pickup-scan",
  "delivery", "delivery-packed", "delivery-saved", "delivery-load", "customer-pickup",
  "receiving-types", "receiving-vendors", "receiving-sources", "receiving-orders", "receipt", "receipt-success",
  "consolidation-queue", "consolidation-pick", "consolidation-review", "consolidation-load", "consolidation-proof", "consolidation-pending", "consolidation-error",
  "fulfillment", "reload", "fulfillment-success",
  "pallet-lookup", "pallet-form", "pallet-review", "stock-lookup", "stock-form", "stock-quality", "stock-review", "return-success", "return-drafts", "return-history",
  "cycle-types", "cycle-sku", "cycle-summary", "damage", "damage-review", "count-sheets", "count-sheet-entry", "count-sheet-review", "history", "history-empty", "settings", "location"
];
const scenes = process.env.PHONE_TEST_SCENES ? allScenes.filter(name => process.env.PHONE_TEST_SCENES.split(",").includes(name)) : allScenes;

const server = createServer(async (request, response) => {
  const pathname = new URL(request.url, "http://localhost").pathname;
  const vendor = pathname.startsWith("/vendor/quagga2/") ? ["node_modules/@ericblade/quagga2/dist", "/vendor/quagga2/"]
    : pathname.startsWith("/vendor/qr-scanner/") ? ["node_modules/qr-scanner", "/vendor/qr-scanner/"] : null;
  const root = vendor?.[0] || "public";
  const filename = vendor ? pathname.slice(vendor[1].length) : pathname === "/operator" ? "operator.html" : pathname === "/login" ? "login.html" : pathname.slice(1);
  const target = path.resolve(root, filename);
  if (!target.startsWith(path.resolve(root) + path.sep)) return response.writeHead(404).end();
  try {
    const data = await readFile(target);
    response.writeHead(200, { "content-type": { ".html": "text/html", ".css": "text/css", ".js": "text/javascript", ".svg": "image/svg+xml" }[path.extname(target)] || "application/octet-stream" }).end(data);
  } catch { response.writeHead(404).end(); }
});
let browser;
// Teardown is established before starting any test server or browser.
try {
  await mkdir(artifacts, { recursive: true });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });

  async function session(userAgent, viewport, gate = { enabled: true, unavailable: false }, keyboardOptions = null) {
    const context = await browser.newContext({ viewport, hasTouch: true, userAgent, serviceWorkers: "block" });
    if (keyboardOptions) await context.addInitScript(installKeyboardViewport, keyboardOptions);
    await context.addInitScript(sessionKey => {
      localStorage.setItem("mbbs.staff.token", "phone-isolated-fixture");
      localStorage.setItem("mbbs.operator.locationId", "1");
      localStorage.setItem("mbbs.ui.language", "en");
      localStorage.setItem("mbbs.operator.state", JSON.stringify({ accountId: "phone-check", sessionKey, locationId: 1, currentModule: "menu" }));
      window.EventSource = class { addEventListener() {} close() {} };
      window.phoneStreamCalls = 0;
      navigator.mediaDevices.getUserMedia = async () => { window.phoneStreamCalls++; throw new Error("Unexpected browser stream in phone fixture"); };
    }, createHash("sha256").update("phone-isolated-fixture").digest("hex"));
    const page = await context.newPage();
    page.on("pageerror", error => errors.push(error.message));
    await page.route("**/api/**", async route => {
      const url = new URL(route.request().url());
      let data = [];
      if (url.pathname === "/api/auth/me") data = { operator: { id: "phone-check", display_name: "Phone operator", role: "operator", roles: ["operator"], operatorYardLocationIds: [1, 28, 15, 26] } };
      else if (url.pathname.endsWith("/notifications")) data = { total: 0, items: [], salesOrder: {}, transferOrder: {} };
      else if (url.pathname.endsWith("/current-draft")) data = null;
      else if (url.pathname.endsWith("/preferences")) data = { keyboard: { orderNumberKeypad: false } };
      else if (url.pathname === "/api/operator/phone-layout-policy") {
        if (gate.unavailable) return route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "Test gate unavailable" }) });
        data = { flagKey: "operator_phone_layout", enabled: gate.enabled, revision: 1 };
      }
      else if (url.pathname === "/api/inventory/damage/config") data = { reasons: [{ id: "broken", label: "Broken in yard" }], month: "2026-10" };
      else if (url.pathname === "/api/inventory/damage/reports") data = { reports: url.searchParams.has("local") ? [] : [report] };
      else if (url.pathname.startsWith("/api/inventory/damage/items/")) data = sku;
      else if (url.pathname === "/api/inventory/damage/items") data = [sku];
      else if (url.pathname.startsWith("/api/count-sheets")) {
        const name = await page.evaluate(() => window.phoneScene);
        const currentSheet = name === "count-sheet-review" ? { ...sheet, status: "submitted" } : sheet;
        data = url.pathname === "/api/count-sheets" ? [currentSheet, { ...sheet, id: "available-sheet", status: "available", owner_id: null }] : currentSheet;
      }
      else if (url.pathname.includes("photo-requirement")) data = { required: true, requiredPhotoCount: 1 };
      else if (url.pathname.includes("netsuite-posting-policy")) data = { effective: false, transactionType: "IF", revision: 1 };
      await route.fulfill({ contentType: "application/json", body: JSON.stringify(data) });
    });
    await page.goto(`${base}/operator`);
    await page.locator('[data-action="open-module"][data-module="delivery"]').waitFor();
    return { context, page, gate };
  }

  async function scene(page, name) {
    await page.evaluate(async ({ name, sku }) => {
      stopOperatorPhotoCameras(); operatorInventory.close();
      window.phoneScene = name;
      app.innerHTML = ""; app.scrollTop = 0;
      const canvas = document.createElement("canvas"); canvas.width = 240; canvas.height = 180;
      const painter = canvas.getContext("2d"); painter.fillStyle = "#c5d2c5"; painter.fillRect(0, 0, 240, 180);
      const photo = canvas.toDataURL("image/jpeg");
      window.phoneFixturePhoto = photo;
      const line = { ...sku, id: "phone-line", item_type: "InvtPart", sku: "STONE-240", unit: "PCS", quantity: 24, piece_qty: 24, pallet_qty: 1, layer_qty: 4, packed_piece_qty: 0, packed_pallet_qty: 0, loaded_qty: 0, confirmed: false, sourceLineId: "phone-line", returnPolicy: { effective: "ALLOWED" }, remainingReturnable: 24, original_quantity: 24 };
      const order = { netsuite_id: "phone-order", tranid: "SOB-TEST-001", order_type: "sales_order", customer: "Phone test customer · Yard Stone", operator_status: "open", lines: [line, { ...line, id: "phone-line-2", sourceLineId: "phone-line-2" }], expected_delivery_date: "2026-10-08", dispatch_plan_date: "2026-10-08", dispatch_truck_plate: "TRUCK-12", dispatch_load_name: "Morning load" };
      const packed = { ...order, operator_status: "packed", lines: order.lines.map(row => ({ ...row, packed_piece_qty: 24, packed_pallet_qty: 1, packed: true, confirmed: true })) };
      const assignment = { planId: "plan-phone", loadId: "load-phone", planDate: "2026-10-08", truckPlate: "TRUCK-12", loadName: "Morning load" };
      selectedOrder = order; selectedId = order.netsuite_id; selectedLineId = line.id;
      orders = [order, { ...order, netsuite_id: "phone-order-2", tranid: "SOB-TEST-002" }, { ...order, netsuite_id: "phone-order-3", tranid: "SOB-TEST-003" }];
      orderPage = 0; linePage = 0; compactLineMode = false; viewMode = "active"; deliveryPrepMode = "standard";
      savedDeliveryOrderKeys = new Set([order.netsuite_id]); deliveryLoadViewDate = "2026-10-08";
      fulfillmentResult = null; fulfillmentSubmitting = false; fulfillmentNetSuitePolicy = { effective: false, revision: 1 }; fulfillmentNetSuitePolicyError = "";
      fulfillmentOrder = packed; fulfillmentPhotoDataUrls = []; fulfillmentActivePhotoSlot = 0;
      receiptOrder = { ...order, order_type: "purchase_order", tranid: "POB-TEST-001", vendor: "Phone test vendor", trandate: "2026-10-08", line_count: 2 }; receiptResult = null; receiptSubmitting = false; receiptPhotoDataUrls = []; receiptActivePhotoSlot = 0;
      receiptNetSuitePolicy = { gateKey: "operator_netsuite_receiving_ir_3445", effective: false, revision: 1 }; receiptNetSuitePolicyError = "";
      if (name === "receipt") receiptOrder = { ...receiptOrder, lines: receiptOrder.lines.map(row => ({ ...row, received_pallet_qty: 1 })) };
      receivingSelectedOrder = receiptOrder; receivingSelectedId = receiptOrder.netsuite_id; receivingSelectedLineId = line.id;
      receivingOrders = [receiptOrder, { ...receiptOrder, netsuite_id: "phone-po-2", tranid: "POB-TEST-002" }];
      receivingVendors = [{ vendor: "Phone test vendor", order_count: 3 }];
      receivingSelectedVendor = "Phone test vendor";
      receivingSources = [{ source_location_id: 28, source_location: "2967", order_count: 2 }];
      receivingOrderType = "purchase_order"; receivingStep = "orders"; receivingSearch = ""; receivingItemSearch = "";
      cycleFacets = { productTypes: [{ value: "Pavers", count: 3 }], brands: [], series: [] };
      inventoryItems = [sku, { ...sku, item_id: 43 }, { ...sku, item_id: 44 }]; selectedInventoryItem = sku; cycleStep = "sku"; cyclePage = 0; cycleSearch = ""; cycleValues = { pieces: 6 };
      resetReturnWorkflow(name.startsWith("stock") ? "stock" : "pallet");
      returnPostingPolicies = Object.fromEntries(["stock_return", "pallet_return"].map(key => [key, { gateKey: `operator_netsuite_${key}_ra_3445`, effective: false, revision: 1, transactionType: "RA" }]));
      returnSelectedCustomer = { id: "customer-phone", code: "CUS-TEST", name: "Phone test customer · Yard Stone" };
      returnLookupData = { order, lines: order.lines, customer: returnSelectedCustomer };
      returnPalletBalance = { available: 12 }; returnPalletQuantity = 2; returnVehiclePlate = "TRUCK-12"; returnHeaderNote = "Unload at the main yard entrance.";
      returnActiveLineId = name.startsWith("stock") ? line.id : "PALLET"; returnStage = "form"; returnView = "workflow";
      returnPhotoTarget = { kind: "record", lineId: "", open: true }; returnRecordPhotos = [photo]; returnPalletPhotos = [photo];
      const savedReturn = { id: "return-phone", returnMode: "pallet", customer: returnSelectedCustomer, palletQuantity: 2, vehiclePlate: "TRUCK-12", status: "completed", createdAt: "2026-10-08T12:00:00Z", photos: [photo] };
      returnDrafts = [savedReturn]; returnHistory = [savedReturn]; returnSelectedRecordId = savedReturn.id;
      const units = [{ key: "pieces", label: "PCS", required: 24, remaining: 24, entered: 0 }];
      const allocation = { batchOrderId: "batch-order", lineKey: line.id, orderRef: order.tranid, planDate: "2026-10-08", truckPlate: "TRUCK-12", loadName: "Morning load", units };
      consolidationBatch = { id: "batch-phone", summary: { items: 1, picking: 1, ready: 0, packed: 0 }, items: [{ key: "stone", itemName: sku.item_name, description: sku.item_description, totals: [{ label: "PCS", required: 24 }], allocations: [allocation] }], orders: [{ id: "batch-order", orderRef: order.tranid, customer: order.customer, status: "picking", planDate: "2026-10-08", truckPlate: "TRUCK-12", loadName: "Morning load", lines: [{ lineKey: line.id, itemName: sku.item_name, description: sku.item_description, units }] }] };
      consolidationSelectedItemKey = "stone"; consolidationStage = "pick";
      consolidationQueue = { total: 1, eligible: 1, blocked: 0, orders: [{ ...allocation, eligible: true, customer: order.customer, lineCount: 2 }] };
      const loadOrder = { ...packed, assignment };
      consolidationLoadState.orders = [loadOrder, { ...loadOrder, netsuite_id: "phone-order-2", tranid: "SOB-TEST-002" }];
      consolidationLoadState.selected = new Map([[loadOrder.netsuite_id, loadOrder]]); consolidationLoadState.pending = []; consolidationLoadState.date = "2026-10-08"; consolidationLoadState.datePreset = "custom";
      const history = { id: "history-phone", type: "delivery", tranid: order.tranid, createdAt: "2026-10-08T12:00:00Z", reference: "IF-TEST-001", lines: order.lines, photos: [photo] };
      personalHistory = [history]; selectedHistoryId = history.id; historyPage = 0;
      currentModule = name;
      if (name.startsWith("receiving-")) {
        currentModule = "receiving";
        receivingStep = name === "receiving-types" ? "type" : name === "receiving-orders" ? "orders" : "vendor";
        if (name === "receiving-sources") receivingOrderType = "transfer_order";
      } else if (name.startsWith("delivery-")) {
        if (!["delivery-select"].includes(name)) {
          currentModule = "delivery";
          if (name === "delivery-packed") { viewMode = "packed"; selectedOrder = packed; orders = [packed]; }
          if (name === "delivery-saved") deliveryPrepMode = "saved";
          if (name === "delivery-load") deliveryPrepMode = "load";
        }
      } else if (name.startsWith("consolidation-")) {
        currentModule = "delivery-consolidation";
        if (name === "consolidation-queue") consolidationBatch = null;
        if (name === "consolidation-review") consolidationStage = "review";
        if (name === "consolidation-load") currentModule = "delivery-consolidation-load";
        if (["consolidation-proof", "consolidation-pending", "consolidation-error"].includes(name)) {
          currentModule = "delivery-consolidation-load-proof";
          fulfillmentOrder = { ...packed, is_consolidation_load: true };
          consolidationLoadState.batch = { id: "load-phone", status: name === "consolidation-proof" ? "ready" : "pending", error: name === "consolidation-error" ? "Load could not be saved. Your photos and selected orders are retained." : "", photoRefs: [photo, photo], snapshot: { orders: [packed, { ...packed, netsuite_id: "phone-order-2", tranid: "SOB-TEST-002" }], assignment } };
        }
      } else if (["fulfillment", "reload", "fulfillment-success"].includes(name)) {
        currentModule = "delivery-fulfill";
        if (name === "reload") fulfillmentOrder = { ...packed, reload_authorized: true, reload_cycle: { reason: "Test local reload", id: 1 }, reload_reason: "Test local reload" };
        if (name.endsWith("success")) fulfillmentResult = { success: true, photosPending: true };
      } else if (name.startsWith("receipt")) {
        currentModule = "receiving-receipt";
        if (name.endsWith("success")) receiptResult = { success: true, photosPending: true };
      } else if (/^(pallet|stock|return)-/.test(name) && name !== "return-select") {
        currentModule = name.startsWith("stock") ? "stock-return" : "pallet-return";
        if (name.endsWith("lookup")) { returnStage = "lookup"; returnLookupData = null; returnSelectedCustomer = null; }
        if (name.endsWith("review")) returnStage = "review";
        if (name === "stock-quality") returnType = "quality";
        if (["stock-quality", "stock-review"].includes(name)) {
          const values = ensureReturnLineValue(line); values.pieces = 6; values.photos = [photo]; values.reasonId = "10"; values.reasonLabel = "Good Condition";
        }
        if (name === "return-success") { returnStage = "success"; returnResult = { id: "return-phone", status: "completed", palletReturnRef: "RA-TEST-001" }; }
        if (name === "return-drafts") returnView = "drafts";
        if (name === "return-history") returnView = "history";
      } else if (name.startsWith("cycle-")) {
        currentModule = "cycle-count";
        if (name === "cycle-types") { cycleStep = "type"; selectedInventoryItem = null; }
        if (name === "cycle-summary") { selectedInventoryItem = null; cycleDraft = { lines: [{ ...line, counted_piece_qty: 6, counted_total_qty: 6 }] }; }
      } else if (["history", "history-empty"].includes(name)) {
        currentModule = "personal-history";
        if (name.endsWith("empty")) { personalHistory = []; selectedHistoryId = ""; }
      } else if (name === "location") { renderLocationSelect(); return; }
      if (["damage", "damage-review", "count-sheets", "count-sheet-entry", "count-sheet-review"].includes(name)) {
        currentModule = name.startsWith("damage") ? "damage" : "count-sheets";
        localStorage.removeItem("mbbs.inventory.sheet.phone-check.1");
        await operatorInventory.open(currentModule);
        return;
      }
      render();
    }, { name, sku });
    if (name === "damage") {
      await page.locator("#damageSearch").fill("STONE");
      await page.locator('[data-inv-action="damage-item"]').first().click();
      await page.locator('[data-inv-action="camera"]:not([disabled])').waitFor();
    }
    if (name === "damage-review") await page.locator('[data-inv-action="damage-review"]').click();
    if (["count-sheet-entry", "count-sheet-review"].includes(name)) {
      await page.locator('[data-inv-action="open-sheet"]').first().click();
      await page.locator('[data-inv-action="count-item"]').first().click();
    }
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  }

  async function assertPhone(page, label) {
    await assertInputFonts(page, label);
    const layout = await page.evaluate(() => {
      const app = document.getElementById("app");
      const outside = [...app.querySelectorAll("button,input,select,textarea")].filter(element => {
        if (element.closest(".topbar-actions") || !element.getClientRects().length) return false;
        const bounds = element.getBoundingClientRect();
        return bounds.width > 0 && (bounds.left < -1 || bounds.right > innerWidth + 1);
      }).map(element => `${element.tagName}.${element.className} ${element.dataset.action || element.dataset.invAction || element.id}`);
      return { phone: document.documentElement.dataset.operatorPhone, scroll: app.scrollWidth - app.clientWidth, outside };
    });
    assert.equal(layout.phone, "true", label);
    assert.ok(layout.scroll <= 1, `${label}: screen overflows by ${layout.scroll}px`);
    assert.deepEqual(layout.outside, [], `${label}: controls outside phone`);
    const inputOrder = await page.evaluate(() => [...document.querySelectorAll('.selected-panel,.return-review-screen')].every(panel => {
      const actions = panel.querySelector('.selected-actions');
      const fields = [...panel.querySelectorAll('.stepper,input,textarea')];
      if (!actions || !fields.length) return true;
      return actions.getBoundingClientRect().top >= Math.max(...fields.map(field => field.getBoundingClientRect().bottom)) - 1;
    }));
    assert.ok(inputOrder, `${label}: confirmation overlaps quantity or review fields`);
    const back = page.locator('.topbar-actions > [data-action="cancel-receive"],.topbar-actions > [data-action="cancel-fulfill"],.topbar-actions > [data-action="return-back-select"],.topbar-actions > [data-action="main-menu"]').first();
    if (await back.count()) {
      const bounds = await back.boundingBox();
      assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= page.viewportSize().width, `${label}: primary navigation is clipped`);
    }
    const lastAction = page.locator(".selected-actions button,.return-bottom-actions button,.return-review-actions button,.display-settings-actions button").last();
    if (await lastAction.count()) {
      await lastAction.scrollIntoViewIfNeeded();
      assert.equal(await lastAction.isVisible(), true, `${label}: final action reachable`);
      const bounds = await lastAction.boundingBox();
      assert.ok(bounds.y >= -1 && bounds.y + bounds.height <= page.viewportSize().height + 1, `${label}: final action clipped`);
    }
    results.push({ label, pass: true });
  }

  for (const gate of [{ enabled: false, unavailable: false }, { enabled: true, unavailable: true }]) {
    const run = await session(iphone, { width: 390, height: 844 }, gate);
    try {
      assert.equal(await run.page.evaluate(() => document.documentElement.dataset.operatorPhone), "false");
      assert.equal(await run.page.evaluate(() => useBasicCameraCapture()), false);
      results.push({ label: `gate defaults to existing layout/${gate.unavailable ? "unavailable" : "disabled"}`, pass: true });
    } finally { await run.context.close(); }
  }
  for (const [label, userAgent, options] of [["iPhone", iphone, {}], ["Android browser", android, {}], ["Android installed app", android, { standalone: true }]]) {
    const run = await session(userAgent, { width: 390, height: 844 }, undefined, options);
    try {
      await checkPhoneKeypad(run.page, scene, results, label);
      await checkPhoneKeyboardScroll(run.page, results, label);
      await checkInputPreferences(run.page, scene, results, label);
    } finally { await run.context.close(); }
  }
  const phone = await session(iphone, { width: 390, height: 844 });
  try {
    for (const [width, height] of [[320, 568], [390, 844], [430, 932], [844, 390]]) {
      await phone.page.setViewportSize({ width, height });
      for (const language of ["en", "zh-CN"]) {
        await phone.page.evaluate(language => window.MBBS_I18N.setLanguage(language), language);
        for (const name of scenes) {
          await scene(phone.page, name);
          await assertPhone(phone.page, `${name}/${language}/${width}x${height}`);
          if (width === 390) {
            await phone.page.evaluate(() => { document.getElementById("app").scrollTop = 0; });
            const screenshotStyle = await phone.page.addStyleTag({ content: 'html,body{height:auto;overflow:visible}html[data-operator-phone="true"] #app.tablet-shell{position:relative;height:auto;overflow:visible}html[data-operator-phone="true"] #app > .topbar{position:relative}' });
            await phone.page.screenshot({ path: `${artifacts}/${name}-${language}.png`, fullPage: true });
            await screenshotStyle.evaluate(element => element.remove());
          }
        }
      }
    }

    // Native intents are opened by a tap; image results and cancellation are checked.
    for (const [name, action, state] of [
      ["fulfillment", "start-camera", "fulfillmentPhotoDataUrls"],
      ["receipt", "start-receipt-camera", "receiptPhotoDataUrls"],
      ["pallet-review", "return-start-camera", "returnTargetPhotos()"],
      ["damage", "camera", null]
    ]) {
      await phone.page.setViewportSize({ width: 390, height: 844 });
      await scene(phone.page, name);
      const button = state ? `[data-action="${action}"]` : `[data-inv-action="${action}"]`;
      const pickerEvent = phone.page.waitForEvent("filechooser");
      await phone.page.locator(button).click();
      const picker = await pickerEvent;
      assert.equal(await picker.element().getAttribute("capture"), "environment");
      assert.equal(await picker.element().getAttribute("accept"), "image/*");
      await picker.element().dispatchEvent("cancel");
      const nextEvent = phone.page.waitForEvent("filechooser");
      await phone.page.locator(button).click();
      const next = await nextEvent;
      const buffer = Buffer.from(await phone.page.evaluate(() => window.phoneFixturePhoto.split(",")[1]), "base64");
      await next.setFiles({ name: "camera.jpg", mimeType: "image/jpeg", buffer });
      await phone.page.waitForFunction(() => !document.querySelector('input[type="file"]'));
      if (state) assert.ok(await phone.page.evaluate(`(${state}).some(photo => photo && photo.startsWith('data:image/'))`));
      else await phone.page.locator(".damage-photos img").waitFor();
      assert.equal(await phone.page.evaluate(() => window.phoneStreamCalls), 0);
      results.push({ label: `iPhone native capture/cancel/${name}`, pass: true });
    }
    for (const [name, action] of [["customer-pickup-scan", "start-pickup-scanner"], ["stock-lookup", "return-start-scanner"]]) {
      await scene(phone.page, name);
      const pickerEvent = phone.page.waitForEvent("filechooser");
      await phone.page.locator(`[data-action="${action}"]`).click();
      const picker = await pickerEvent;
      assert.equal(await picker.element().getAttribute("capture"), "environment");
      await picker.element().dispatchEvent("cancel");
      assert.equal(await phone.page.evaluate(() => window.phoneStreamCalls), 0);
      results.push({ label: `iPhone native barcode camera/${name}`, pass: true });
    }
    for (const [name, button, selector, selected] of [
      ["delivery", '.line-card[data-line="phone-line-2"]', ".work-area .selected-panel", "selectedLineId"],
      ["receiving-orders", '[data-action="select-receiving-line"][data-line="phone-line-2"]', ".receiving-detail-grid .selected-panel", "receivingSelectedLineId"],
      ["stock-form", '[data-action="return-select-stock-line"][data-source-line="phone-line-2"]', ".return-selected-editor", "returnActiveLineId"]
    ]) {
      await scene(phone.page, name);
      await phone.page.locator(button).click();
      await phone.page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      assert.equal(await phone.page.evaluate(selected), "phone-line-2");
      const bounds = await phone.page.locator(selector).boundingBox();
      const header = await phone.page.locator(".topbar").boundingBox();
      assert.ok(bounds.y >= header.y + header.height - 1 && bounds.y < 700, `${name}: selected editor is shown below the phone header`);
      results.push({ label: `phone selection reveals editor/${name}`, pass: true });
    }
    await scene(phone.page, "customer-pickup");
    const original = await phone.page.evaluate(() => ({ module: currentModule, order: selectedId, line: selectedLineId }));
    phone.gate.enabled = false;
    await phone.page.evaluate(() => refreshOperatorPhonePolicy());
    assert.equal(await phone.page.evaluate(() => document.documentElement.dataset.operatorPhone), "false");
    phone.gate.enabled = true;
    await phone.page.evaluate(() => refreshOperatorPhonePolicy());
    assert.equal(await phone.page.evaluate(() => document.documentElement.dataset.operatorPhone), "true");
    assert.deepEqual(await phone.page.evaluate(() => ({ module: currentModule, order: selectedId, line: selectedLineId })), original);
    phone.gate.unavailable = true;
    await phone.page.evaluate(() => refreshOperatorPhonePolicy());
    assert.equal(await phone.page.evaluate(() => document.documentElement.dataset.operatorPhone), "false");
    results.push({ label: "live gate enable/disable/failure retains selected work", pass: true });
  } finally { await phone.context.close(); }

  const androidPhone = await session(android, { width: 390, height: 844 });
  try {
    await scene(androidPhone.page, "menu"); await assertPhone(androidPhone.page, "Android portrait");
    await androidPhone.page.setViewportSize({ width: 844, height: 390 });
    await scene(androidPhone.page, "fulfillment"); await assertPhone(androidPhone.page, "Android landscape");
  } finally { await androidPhone.context.close(); }

  // Compare the actual tablet DOM with the added stylesheet enabled and disabled.
  const tabletRun = await session(tablet, { width: 1280, height: 800 });
  try {
    for (const [width, height] of [[390, 844], [600, 900], [601, 900], [768, 1024], [1024, 768], [1280, 800]]) {
      await tabletRun.page.setViewportSize({ width, height });
      for (const name of scenes.filter(name => name !== "location")) {
        await scene(tabletRun.page, name);
        await assertInputFonts(tabletRun.page, `${name}/${width}: tablet`);
        assert.equal(await tabletRun.page.evaluate(() => document.documentElement.dataset.operatorPhone), "false");
        const snapshot = async () => tabletRun.page.evaluate(() => [...document.querySelectorAll("#app,#app *")].map(element => {
          const bounds = element.getBoundingClientRect(), css = getComputedStyle(element);
          return [bounds.x, bounds.y, bounds.width, bounds.height, css.display, css.overflow, css.gridTemplateColumns, css.gridTemplateRows, css.fontSize, css.padding, css.position];
        }));
        const enabled = await snapshot();
        await tabletRun.page.evaluate(() => { document.querySelector('link[href*="operator-phone.css"]').disabled = true; });
        const disabled = await snapshot();
        assert.deepEqual(enabled, disabled, `${name}/${width}: phone stylesheet changed tablet`);
        await tabletRun.page.evaluate(() => { document.querySelector('link[href*="operator-phone.css"]').disabled = false; });
        results.push({ label: `tablet unchanged/${name}/${width}x${height}`, pass: true });
      }
    }
    await checkInputPreferences(tabletRun.page, scene, results, "Tablet");
  } finally { await tabletRun.context.close(); }
  assert.deepEqual(errors, [], "Browser runtime errors");
  console.log(`PASS: ${results.length} screen, camera and tablet checks`);
} catch (error) {
  results.push({ pass: false, error: error.stack });
  throw error;
} finally {
  await writeFile(`${artifacts}/browser-results${process.env.PHONE_TEST_SCENES ? "-populated" : ""}.json`, JSON.stringify({ results, errors }, null, 2));
  if (browser) await browser.close();
  if (server.listening) await new Promise(resolve => server.close(resolve));
}
