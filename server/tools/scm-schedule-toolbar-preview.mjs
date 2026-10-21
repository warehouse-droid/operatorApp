import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import http from "node:http";
import { resolve } from "node:path";
import { chromium } from "@playwright/test";

const out = resolve("test-artifacts/scm-schedule-toolbar-20261001");
await mkdir(out, { recursive: true });
const row = {
  orderKind: "PO", orderRef: "PO-UI-1", status: "Queued", method: "Vendor",
  pickupPoint: "Vendor Yard", pickupOptions: ["Vendor Yard"], dropoffPoint: "12441",
  dropoffOptions: ["12441", "2967"], party: "Example Vendor", brand: "Example",
  content: "Test pavers", weightLbs: 1200, etaDate: "2026-09-11", etaTime: "09:30",
  driver: "UI Driver", sla: "2 days", slaDays: 2, remarkOverride: "Original remark",
  updatedAt: "2026-09-10T12:00:00.000Z", packingSlipRef: "PK1"
};
const rows = [row, { ...row, orderRef: "PO-UI-2" }];
const errors = [];
const server = http.createServer(async (req, res) => {
  const path = new URL(req.url, "http://localhost").pathname;
  if (path.endsWith(".js") || path.endsWith(".css")) {
    res.setHeader("Content-Type", path.endsWith(".js") ? "text/javascript" : "text/css");
    res.end(await readFile(resolve("public", path.slice(1))));
  } else if (path.startsWith("/api/")) {
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(path.includes("presets")
      ? ["SCM Working", "Dispatch", "Yard Manager", "Completed"].map(name => ({ name }))
      : path.endsWith("/schedule") ? { rows } : { persisted: false, showDetails: false }));
  } else {
    res.setHeader("Content-Type", "text/html");
    res.end(`<!doctype html><html><head><meta charset="UTF-8"><link rel="stylesheet" href="/dispatch.css"></head>
      <body><main id="scmScheduleApp" class="dispatch-shell scm-schedule-shell"></main>
      <script>function requireDispatchLogin({onReady}) {
        window.scheduleReady = onReady({id:"ui-admin",role:"admin",username:"UI Admin"});
      }</script><script src="/scm-schedule.js"></script></body></html>`);
  }
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
const results = [];
try {
  for (const width of [1440, 1280, 1180]) {
    const context = await browser.newContext({ viewport: { width, height: 900 } });
    const page = await context.newPage();
    page.on("pageerror", error => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}/scm/POTOschedule`);
    await page.evaluate(() => window.scheduleReady);
    await page.evaluate(() => {
      scmScheduleFilters.brand = ["Example"];
      scmScheduleSelectedRows.add("PO::PO-UI-1");
      scmScheduleSelectedRows.add("PO::PO-UI-2");
      renderScmSchedule();
    });
    const geometry = await page.evaluate(width => {
      const toolbar = document.querySelector(".scm-schedule-toolbar");
      const bounds = toolbar.getBoundingClientRect();
      return {
        width, toolbarWidth: bounds.width, toolbarHeight: bounds.height,
        summaryCount: toolbar.querySelectorAll(".scm-sort-summary, [data-schedule-sort-summary]").length,
        controls: [...toolbar.children].filter(element => element.getBoundingClientRect().width > 0)
          .map(element => { const rect = element.getBoundingClientRect(); return {
            name: element.dataset.filter || element.dataset.action || element.className,
            left: rect.left, right: rect.right, centerY: rect.top + rect.height / 2, width: rect.width
          }; })
      };
    }, width);
    results.push(geometry);
    await page.screenshot({ path: `${out}/toolbar-${width}.png` });
    const chooser = page.locator("[data-schedule-columns]");
    await chooser.locator("summary").click();
    await chooser.getByLabel("Remark", { exact: true }).uncheck();
    assert.equal(await chooser.getByLabel("Remark", { exact: true }).isChecked(), false);
    assert.equal(geometry.summaryCount, 0);
    const centers = geometry.controls.map(control => control.centerY);
    assert.ok(Math.max(...centers) - Math.min(...centers) < 1, "Toolbar controls must share one row");
    assert.ok(Math.max(...geometry.controls.map(control => control.right)) <= width, "All toolbar controls must fit");
    await context.close();
  }
  assert.deepEqual(errors, []);
} finally {
  await writeFile(`${out}/layout.json`, JSON.stringify({ results, errors }, null, 2));
  await browser.close();
  await new Promise(resolve => server.close(resolve));
}
console.log(JSON.stringify({ toolbarLayouts: results.map(({ width, toolbarHeight }) => ({ width, toolbarHeight })),
  summaryHidden: true, oneRow: true, columnsMenuUsable: true, browserErrors: errors }));
