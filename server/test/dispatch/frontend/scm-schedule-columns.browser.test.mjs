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
