import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
import http from "node:http";
import { before, after, test } from "node:test";
import { chromium, expect as browserExpect } from "@playwright/test";

const expect = browserExpect.configure({ timeout: 2000 });

const publicRoot = new URL("../../../public/", import.meta.url);
const row = {
  orderKind: "PO", orderRef: "PO-UI-1", status: "Queued", method: "Vendor",
  pickupPoint: "Vendor Yard", pickupOptions: ["Vendor Yard"], dropoffPoint: "12441",
  dropoffOptions: ["12441", "2967"], party: "Example Vendor", brand: "Example",
  content: "Test pavers", weightLbs: 1200, etaDate: "2026-09-11", etaTime: "09:30",
  driver: "UI Driver", sla: "2 days", slaDays: 2, remarkOverride: "Original remark",
  updatedAt: "2026-09-10T12:00:00.000Z", packingSlipRef: "PK1"
};
let browser;
let server;
let baseUrl;
const browserErrors = [];

before(async () => {
  server = http.createServer(async (req, res) => {
    const path = new URL(req.url, "http://localhost").pathname;
    if (path.endsWith(".js") || path.endsWith(".css")) {
      res.setHeader("Content-Type", path.endsWith(".js") ? "text/javascript" : "text/css");
      const override = path === "/scm-schedule.js" ? process.env.SCHEDULE_TEST_CLIENT
        : path === "/dispatch.css" ? process.env.SCHEDULE_TEST_CSS : "";
      res.end(await readFile(override || new URL(path.slice(1), publicRoot)));
      return;
    }
    if (path.startsWith("/api/")) {
      res.setHeader("Content-Type", "application/json");
      if (req.method === "PUT") {
        let body = "";
        for await (const chunk of req) body += chunk;
        res.end(JSON.stringify({ row: { ...row, ...JSON.parse(body), updatedAt: "2026-09-10T13:00:00.000Z" } }));
      } else if (path.includes("presets")) {
        res.end(JSON.stringify(["SCM Working", "Dispatch", "Yard Manager", "Completed"].map((name) => ({ name }))));
      } else if (path.endsWith("/schedule")) {
        res.end(JSON.stringify({ rows: [row, { ...row, orderRef: "PO-UI-2" }] }));
      } else {
        res.end(JSON.stringify({ persisted: false, showDetails: false }));
      }
      return;
    }
    res.setHeader("Content-Type", "text/html");
    res.end(`<!doctype html><html><head><meta charset="UTF-8"><link rel="stylesheet" href="/dispatch.css"></head><body>
      <main id="scmScheduleApp" class="dispatch-shell scm-schedule-shell"></main>
      <script>
        function requireDispatchLogin({onReady}) {
          const operator = JSON.parse(localStorage.getItem("testOperator") || '{"id":"ui-admin","role":"admin","username":"UI Admin"}');
          window.scheduleReady = onReady(operator);
        }
      </script><script src="/scm-schedule.js"></script></body></html>`);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
});

after(async () => {
  await browser?.close();
  await new Promise((resolve) => server?.close(resolve));
  assert.deepEqual(browserErrors, [], "The real schedule script must run without browser exceptions");
});

async function openSchedule(t, path = "/scm/POTOschedule", setup) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  context.setDefaultTimeout(2500);
  t.after(() => context.close());
  if (setup) await context.addInitScript(setup);
  const page = await context.newPage();
  page.on("pageerror", (error) => browserErrors.push(error.message));
  await page.goto(`${baseUrl}${path}`);
  await page.evaluate(() => window.scheduleReady);
  await expect(page.locator(".scm-sheet-row")).toHaveCount(2);
  return page;
}

async function columns(page) {
  const chooser = page.locator("[data-schedule-columns]");
  if (!await chooser.evaluate((element) => element.open)) await chooser.locator("summary").click();
  return chooser;
}

async function assertAligned(page) {
  const geometry = await page.evaluate(() => {
    const visible = (selector) => [...document.querySelectorAll(selector)]
      .filter((element) => getComputedStyle(element).display !== "none")
      .map((element) => ({ key: element.dataset.columnKey, x: Math.round(element.getBoundingClientRect().x), width: Math.round(element.getBoundingClientRect().width) }));
    return {
      headers: visible(".scm-sheet-header"),
      rows: [...document.querySelectorAll(".scm-sheet-row")].map((element) =>
        [...element.children].filter((cell) => getComputedStyle(cell).display !== "none")
          .map((cell) => ({ key: cell.dataset.columnKey, x: Math.round(cell.getBoundingClientRect().x), width: Math.round(cell.getBoundingClientRect().width) })))
    };
  });
  assert.ok(geometry.headers.length > 0);
  for (const cells of geometry.rows) assert.deepEqual(cells, geometry.headers);
}

test("ETA, Driver and SLA render once in a compact labeled column with all filters", async (t) => {
  const page = await openSchedule(t);
  const cell = page.locator('.scm-sheet-row [data-column-key="timing"]').first();
  await expect(cell).toContainText("ETA");
  await expect(cell).toContainText("2026-09-11 09:30");
  await expect(cell).toContainText("Driver");
  await expect(cell).toContainText("UI Driver");
  await expect(cell).toContainText("SLA");
  await expect(cell).toContainText("2 days");
  assert.ok((await cell.boundingBox()).width <= 180);
  await expect(page.locator('.scm-sheet-header[data-column-key="driver"], .scm-sheet-header[data-column-key="sla"], .scm-sheet-header[data-column-key="eta"]')).toHaveCount(0);
  for (const field of ["from", "to", "driverSearch", "slaMin", "slaMax"]) {
    await expect(page.locator(`.scm-sheet-header[data-column-key="timing"] [data-filter="${field}"]`)).toHaveCount(1);
  }
  await assertAligned(page);
  if (process.env.SCHEDULE_SCREENSHOT_DIR) {
    await mkdir(process.env.SCHEDULE_SCREENSHOT_DIR, { recursive: true });
    await page.locator(".scm-sheet-wrap").evaluate((element) => { element.scrollLeft = element.scrollWidth; });
    await page.screenshot({ path: `${process.env.SCHEDULE_SCREENSHOT_DIR}/compact-column.png` });
    await columns(page);
    await page.screenshot({ path: `${process.env.SCHEDULE_SCREENSHOT_DIR}/columns-chooser.png` });
  }
});

test("visibility changes preserve unsaved edits, selection and filters; saving retains hidden columns", async (t) => {
  const page = await openSchedule(t);
  const remark = page.locator('[data-row="PO::PO-UI-1"][data-field="remarkOverride"]');
  await remark.fill("Unsaved remark survives hiding");
  await page.locator('[data-action="select-row"][data-row="PO::PO-UI-1"]').check();
  await page.evaluate(() => { scmScheduleFilters.driverSearch = "UI"; });
  const chooser = await columns(page);
  await chooser.getByLabel("Remark", { exact: true }).uncheck();
  await chooser.getByLabel("ETA / Driver / SLA", { exact: true }).uncheck();
  await expect(remark).toBeHidden();
  await expect(remark).toHaveValue("Unsaved remark survives hiding");
  await expect(page.locator('.scm-sheet-header[data-column-key="timing"]')).toBeHidden();
  await expect(page.locator('[data-action="select-row"][data-row="PO::PO-UI-1"]')).toBeChecked();
  assert.equal(await page.evaluate(() => scmScheduleFilters.driverSearch), "UI");
  await assertAligned(page);
  await chooser.locator("summary").click();
  await page.locator('[data-action="save-row"][data-row="PO::PO-UI-1"]').click();
  await expect(page.locator(".scm-notice")).toContainText("Saved PO-UI-1");
  await expect(page.locator('[data-row="PO::PO-UI-1"][data-field="remarkOverride"]')).toHaveValue("Unsaved remark survives hiding");
  await expect(page.locator('.scm-sheet-row [data-column-key="timing"]').first()).toBeHidden();
  await assertAligned(page);
});

test("column choices persist on reload and remain separate for another user and surface", async (t) => {
  const page = await openSchedule(t);
  await (await columns(page)).getByLabel("ETA / Driver / SLA", { exact: true }).uncheck();
  await page.reload();
  await page.evaluate(() => window.scheduleReady);
  await expect(page.locator('.scm-sheet-header[data-column-key="timing"]')).toBeHidden();
  await page.goto(`${baseUrl}/dispatch/po-to-schedule`);
  await page.evaluate(() => window.scheduleReady);
  await expect(page.locator('.scm-sheet-header[data-column-key="timing"]')).toBeVisible();
  await page.evaluate(() => localStorage.setItem("testOperator", JSON.stringify({ id: "second-user", role: "admin" })));
  await page.goto(`${baseUrl}/scm/POTOschedule`);
  await page.evaluate(() => window.scheduleReady);
  await expect(page.locator('.scm-sheet-header[data-column-key="timing"]')).toBeVisible();
});

test("Show all and Reset layout restore columns without discarding drafts", async (t) => {
  const page = await openSchedule(t);
  const remark = page.locator('[data-row="PO::PO-UI-1"][data-field="remarkOverride"]');
  await remark.fill("Keep draft on reset");
  const chooser = await columns(page);
  for (const checkbox of await chooser.locator('input[type="checkbox"]').all()) {
    if (await checkbox.isEnabled()) await checkbox.uncheck();
  }
  assert.equal(await page.locator('.scm-sheet-header:not([hidden])').count(), 1);
  await assertAligned(page);
  await chooser.getByRole("button", { name: "Show all" }).click();
  await expect(page.locator('.scm-sheet-header[hidden]')).toHaveCount(0);
  await chooser.getByLabel("ETA / Driver / SLA", { exact: true }).uncheck();
  await chooser.locator("summary").click();
  await page.getByRole("button", { name: "Reset layout", exact: true }).click();
  await expect(remark).toHaveValue("Keep draft on reset");
  await expect(page.locator('.scm-sheet-header[hidden]')).toHaveCount(0);
  await assertAligned(page);
});

test("read-only users can hide columns using keyboard controls", async (t) => {
  const page = await openSchedule(t, "/sales/schedule", () => {
    localStorage.setItem("testOperator", JSON.stringify({ id: "sales-user", role: "sales" }));
  });
  const summary = page.locator("[data-schedule-columns] > summary");
  await summary.focus();
  await page.keyboard.press("Enter");
  const chooser = page.locator("[data-schedule-columns]");
  await expect(chooser.getByLabel("Selection", { exact: true })).toHaveCount(0);
  const checkbox = chooser.getByLabel("ETA / Driver / SLA", { exact: true });
  await checkbox.focus();
  await page.keyboard.press("Space");
  await expect(page.locator('.scm-sheet-header[data-column-key="timing"]')).toBeHidden();
  await page.keyboard.press("Escape");
  await expect(summary).toBeFocused();
  assert.equal(await chooser.evaluate((element) => element.open), false);
  await assertAligned(page);
});

test("malformed stored choices and unavailable storage do not break the grid", async (t) => {
  const page = await openSchedule(t, "/scm/POTOschedule", () => {
    localStorage.setItem("mbbs.scmSchedule.columns.v1.scm.ui-admin", '{"hiddenColumns":"all"}');
  });
  await expect(page.locator('.scm-sheet-header[hidden]')).toHaveCount(0);
  await page.evaluate(() => {
    Storage.prototype.setItem = () => { throw new Error("storage blocked"); };
  });
  await (await columns(page)).getByLabel("ETA / Driver / SLA", { exact: true }).uncheck();
  await expect(page.locator('.scm-sheet-header[data-column-key="timing"]')).toBeHidden();
  await assertAligned(page);
});

const sortRows = [
  { ...row, orderRef: "PO-A", orderKind: "PO", brand: "A", method: "MBT", dropoffPoint: "3445", weightLbs: 10, queuedDate: "2026-10-03" },
  { ...row, orderRef: "VRMA-B", orderKind: "VRMA", brand: "B", method: "Vendor", dropoffPoint: "12441", weightLbs: 2, queuedDate: "2026-10-02" },
  { ...row, orderRef: "PO-B", orderKind: "PO", brand: "B", method: "Vendor", dropoffPoint: "2967 + 3445", weightLbs: 100, queuedDate: "2026-10-01" },
  { ...row, orderRef: "VRMA-A", orderKind: "VRMA", brand: "A", method: "Customer Pickup", dropoffPoint: "150", weightLbs: 20, queuedDate: "2026-10-04" }
];

async function useFixtureRows(page, rows = sortRows) {
  const scheduleRequests = [];
  let preference = { persisted: false };
  await page.route(/\/api\/scm\/schedule-preferences\/(?:scm|dispatch)$/, async (route) => {
    if (route.request().method() === "PUT") preference = { ...route.request().postDataJSON(), persisted: true };
    await route.fulfill({ json: preference });
  });
  await page.route(/\/api\/(scm|sales)\/schedule(?:\?|$)/, async (route) => {
    const params = new URL(route.request().url()).searchParams;
    scheduleRequests.push(params);
    const kinds = params.getAll("kind");
    const methods = params.getAll("method");
    const dropoffs = params.getAll("dropoffPoint");
    await route.fulfill({ json: { rows: rows.filter((item) =>
      (!kinds.length || kinds.some((kind) => kind === "Sp.O" ? item.isSpecialOrder && item.orderKind === "PO" : item.orderKind === kind))
      && (!methods.length || methods.includes(item.method))
      && (!dropoffs.length || dropoffs.some((yard) => item.dropoffPoint.replace(/\s/g, "").split("+").includes(yard)))
      && (params.get("view") !== "dispatch" || item.method === "MBT")) } });
  });
  await page.evaluate(() => loadScmSchedule());
  return scheduleRequests;
}

test("automatic special orders show Sp.O and keep the SO prefix separate from editable remarks", async (t) => {
  const page = await openSchedule(t);
  await page.setViewportSize({ width: 2400, height: 700 });
  const special = { ...row, isSpecialOrder: true, isAutomaticSpecialOrder: true,
    remarkPrefix: "For SOB12345", remark: "For SOB12345 Original remark", netSuiteMemo: "Vendor memo" };
  await useFixtureRows(page, [special]);
  const scheduleRow = page.locator(".scm-sheet-row");
  await expect(scheduleRow.locator('[data-column-key="type"] > strong')).toHaveText("Sp.O");
  await expect(scheduleRow.locator('[data-field="isSpecialOrder"]')).toBeChecked();
  await expect(scheduleRow.locator('[data-field="isSpecialOrder"]')).toBeDisabled();
  await expect(scheduleRow.locator('[data-column-key="remark"] .scm-readonly-value')).toHaveText("For SOB12345");
  const remark = scheduleRow.locator('[data-field="remarkOverride"]');
  await expect(remark).toHaveValue("Original remark");
  await remark.fill("Call vendor");
  const patch = await page.evaluate(() => collectRowPatch(scheduleRowId(scmScheduleRows[0])));
  assert.equal(patch.remarkOverride, "Call vendor");
  assert.equal(Object.hasOwn(patch, "isSpecialOrder"), false, "Saving an automatic classification must not persist a manual flag");
  await page.evaluate(() => setScmScheduleRowControlsDisabled(scheduleRowId(scmScheduleRows[0]), false));
  await expect(scheduleRow.locator('[data-field="isSpecialOrder"]')).toBeDisabled();
  await remark.fill("");
  await expect(remark).toHaveAttribute("placeholder", "Vendor memo");
  await expect(scheduleRow.locator('[data-column-key="remark"] .scm-readonly-value')).toHaveText("For SOB12345");
  await mkdir("test-artifacts/scm-auto-special-order", { recursive: true });
  await page.screenshot({ path: "test-artifacts/scm-auto-special-order/schedule.png", fullPage: true });
});

test("read-only schedules display the combined SO remark and special-order type", async (t) => {
  const page = await openSchedule(t, "/dispatch/po-to-schedule");
  await useFixtureRows(page, [{ ...row, method: "MBT", isSpecialOrder: true, isAutomaticSpecialOrder: true,
    remarkPrefix: "For SOB12345", remark: "For SOB12345 Call vendor", remarkOverride: "Call vendor", remarkSource: "local" }]);
  const scheduleRow = page.locator(".scm-sheet-row");
  await expect(scheduleRow.locator('[data-column-key="type"] > strong')).toHaveText("Sp.O");
  await expect(scheduleRow.locator('[data-column-key="remark"]')).toContainText("For SOB12345 Call vendor");
});

async function displayedRefs(page) {
  return page.locator(".scm-sheet-row").evaluateAll((elements) => elements.map((element) => element.dataset.rowRef));
}

async function sortColumn(page, key) {
  await page.locator(`[data-action="sort-column"][data-sort-key="${key}"]`).first().click();
}

test("spreadsheet sort sequence matters and each header shows direction and priority", async (t) => {
  const page = await openSchedule(t);
  const requests = await useFixtureRows(page);
  assert.deepEqual(await displayedRefs(page), ["PO-B", "VRMA-B", "PO-A", "VRMA-A"]);
  await sortColumn(page, "type");
  await sortColumn(page, "brand");
  assert.deepEqual(await displayedRefs(page), ["PO-A", "VRMA-A", "PO-B", "VRMA-B"]);
  await expect(page.locator('[data-sort-key="brand"] [data-sort-indicator]')).toHaveText("↑1");
  await expect(page.locator('[data-sort-key="type"] [data-sort-indicator]')).toHaveText("↑2");
  await page.getByRole("button", { name: "Reset sort", exact: true }).click();
  await sortColumn(page, "brand");
  await sortColumn(page, "type");
  assert.deepEqual(await displayedRefs(page), ["PO-A", "PO-B", "VRMA-A", "VRMA-B"]);
  await sortColumn(page, "brand");
  assert.deepEqual(await displayedRefs(page), ["PO-B", "VRMA-B", "PO-A", "VRMA-A"]);
  await expect(page.locator('[data-sort-key="brand"] [data-sort-indicator]')).toHaveText("↓1");
  await expect(page.locator('[data-sort-key="type"] [data-sort-indicator]')).toHaveText("↑2");
  await expect(page.locator('[data-sort-key="date"] [data-sort-indicator]')).toHaveText("↑3");
  await expect(page.locator('[data-schedule-sort-summary], .scm-sort-summary')).toHaveCount(0);
  assert.equal(requests.length, 1, "Sorting should not reload the schedule");
  await assertAligned(page);
  if (process.env.SCHEDULE_SCREENSHOT_DIR) {
    await page.screenshot({ path: `${process.env.SCHEDULE_SCREENSHOT_DIR}/sort-priorities.png` });
  }
});

test("sorting preserves row nodes, drafts, selection, filter drafts, hidden columns and expanded details", async (t) => {
  const page = await openSchedule(t);
  await useFixtureRows(page);
  await page.evaluate(() => {
    scmScheduleShowReconciliationDetails = true;
    scmScheduleExpandedReconciliationRows.add("PO::PO-A");
    renderScmSchedule();
    window.originalScheduleRow = document.querySelector('[data-schedule-row="PO::PO-A"]');
  });
  const remark = page.locator('[data-row="PO::PO-A"][data-field="remarkOverride"]');
  await remark.fill("Keep my unsaved edit");
  await page.locator('[data-row="PO::PO-A"][data-field="packingSlipRef"]').fill("DRAFT-PACK");
  await page.locator('[data-row="PO::PO-A"][data-action="select-row"]').check();
  await (await columns(page)).getByLabel("Remark", { exact: true }).uncheck();
  await page.locator("[data-schedule-columns] > summary").click();
  const kindFilter = page.locator('[data-multi-filter="kind"]');
  await kindFilter.locator("summary").click();
  await kindFilter.getByLabel("TO", { exact: true }).check();
  await kindFilter.locator("summary").click();
  await sortColumn(page, "weight");
  assert.deepEqual(await displayedRefs(page), ["VRMA-B", "PO-A", "VRMA-A", "PO-B"]);
  await expect(remark).toHaveValue("Keep my unsaved edit");
  await expect(remark).toBeHidden();
  await expect(page.locator('[data-row="PO::PO-A"][data-field="packingSlipRef"]')).toHaveValue("DRAFT-PACK");
  await expect(page.locator('[data-row="PO::PO-A"][data-action="select-row"]')).toBeChecked();
  assert.equal(await page.evaluate(() => window.originalScheduleRow === document.querySelector('[data-schedule-row="PO::PO-A"]')), true);
  assert.equal(await page.evaluate(() => window.originalScheduleRow.nextElementSibling.dataset.reconciliationDetail), "PO::PO-A");
  await expect(kindFilter.getByLabel("TO", { exact: true })).toBeChecked();
  assert.deepEqual(await page.evaluate(() => scmScheduleFilters.kind), []);
  await assertAligned(page);
  const weight = page.locator('[data-sort-key="weight"]');
  await weight.focus();
  await page.keyboard.press("Enter");
  await expect(weight).toBeFocused();
  assert.deepEqual(await displayedRefs(page), ["PO-B", "VRMA-A", "PO-A", "VRMA-B"]);
});

test("Method, Type and Drop-off multi-selects apply together, persist and clear", async (t) => {
  const page = await openSchedule(t);
  const requests = await useFixtureRows(page, [...sortRows,
    { ...row, orderRef: "SPECIAL", orderKind: "PO", isSpecialOrder: true, method: "Vendor", dropoffPoint: "12441 + 150" }
  ]);
  for (const [field, values] of [["method", ["MBT", "Vendor"]], ["kind", ["PO", "Sp.O"]], ["dropoffPoint", ["3445", "150"]]]) {
    const filter = page.locator(`[data-multi-filter="${field}"]`);
    await filter.locator("summary").click();
    for (const value of values) await filter.getByLabel(value, { exact: true }).check();
    await filter.locator("summary").click();
  }
  assert.equal(requests.length, 1, "Checking options should not apply them yet");
  const dropoff = page.locator('[data-multi-filter="dropoffPoint"]');
  await dropoff.locator("summary").click();
  await dropoff.getByRole("button", { name: "Apply", exact: true }).click();
  await expect(page.locator(".scm-sheet-row")).toHaveCount(3);
  assert.deepEqual(new Set(await displayedRefs(page)), new Set(["PO-A", "PO-B", "SPECIAL"]));
  assert.deepEqual(requests.at(-1).getAll("method"), ["MBT", "Vendor"]);
  assert.deepEqual(requests.at(-1).getAll("kind"), ["PO", "Sp.O"]);
  assert.deepEqual(requests.at(-1).getAll("dropoffPoint"), ["150", "3445"]);
  await page.reload();
  await page.evaluate(() => window.scheduleReady);
  await expect(page.locator(".scm-sheet-row")).toHaveCount(3);
  for (const field of ["method", "kind", "dropoffPoint"]) {
    await expect(page.locator(`[data-multi-filter="${field}"] input:checked`)).toHaveCount(2);
  }
  const method = page.locator('[data-multi-filter="method"]');
  await method.locator("summary").click();
  await method.getByRole("button", { name: "Clear", exact: true }).click();
  await expect(method.locator("input:checked")).toHaveCount(0);
  await method.getByRole("button", { name: "Apply", exact: true }).click();
  await expect.poll(() => requests.at(-1).getAll("method")).toEqual([]);
  await page.getByRole("button", { name: "Clear column filters", exact: true }).click();
  await expect(page.locator(".scm-sheet-row")).toHaveCount(5);
  await expect(page.getByRole("button", { name: "Clear column filters", exact: true })).toHaveCount(0);
});

test("only the Dispatch view hides Method; Completed supports multiple methods on the Dispatch page", async (t) => {
  const page = await openSchedule(t, "/dispatch/po-to-schedule");
  const requests = await useFixtureRows(page);
  await expect(page.locator('[data-multi-filter="method"]')).toHaveCount(0);
  await expect(page.locator('[data-multi-filter="kind"], [data-multi-filter="dropoffPoint"]')).toHaveCount(2);
  for (const key of ["method", "eta", "driver", "sla", "weight"]) {
    await expect(page.locator(`[data-action="sort-column"][data-sort-key="${key}"]`).first()).toBeVisible();
  }
  await page.locator('[data-filter="view"]').selectOption("completed");
  await expect(page.locator('[data-multi-filter="method"]')).toHaveCount(1);
  const method = page.locator('[data-multi-filter="method"]');
  await method.locator("summary").click();
  for (const value of ["MBT", "Vendor"]) await method.getByLabel(value, { exact: true }).check();
  await method.getByRole("button", { name: "Apply", exact: true }).click();
  await expect.poll(() => requests.at(-1).getAll("method")).toEqual(["MBT", "Vendor"]);
  await expect(page.locator(".scm-sheet-row")).toHaveCount(3);
  await page.reload();
  await page.evaluate(() => window.scheduleReady);
  await expect(page.locator('[data-multi-filter="method"]')).toHaveCount(0);
  assert.deepEqual(requests.at(-1).getAll("method"), []);
  await page.locator('[data-filter="view"]').selectOption("completed");
  await expect(page.locator('[data-multi-filter="method"] input:checked')).toHaveCount(2);
});
