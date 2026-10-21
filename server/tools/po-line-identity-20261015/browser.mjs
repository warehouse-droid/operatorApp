import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { parse } from "espree";
import { chromium } from "playwright";

const source = fs.readFileSync("public/dispatch.js", "utf8");
const parsed = parse(source, { ecmaVersion: "latest", sourceType: "script", range: true });
const declaration = parsed.body.find(node => node.type === "FunctionDeclaration" && node.id?.name === "ungroupOrderWithPoCheck");
const registration = parsed.body.find(node => node.type === "ExpressionStatement"
  && node.expression.type === "CallExpression" && node.expression.callee.object?.name === "app"
  && node.expression.callee.property?.name === "addEventListener" && node.expression.arguments[0]?.value === "click");
const callback = registration.expression.arguments[1];
const helper = source.slice(...declaration.range);
const handler = source.slice(...callback.range);
for (const file of ["public/dispatch.html", "public/mbt-planning.html"]) {
  assert.match(fs.readFileSync(file, "utf8"), /dispatch\.js\?v=20261015-po-lines-ungroup-v1/);
}
const browser = await chromium.launch({ headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
try {
  const context = await browser.newContext();
  const page = await context.newPage();
  let requests = 0;
  await page.route("http://po-identity.test/**", async route => {
    if (route.request().url().includes("/po-allocations?")) {
      requests += 1;
      assert.equal(route.request().method(), "GET");
      return route.fulfill({ contentType: "application/json", body: JSON.stringify({ allocations: [
        { id: "259", poOrderRef: "SN1402535" }, { id: "260", poOrderRef: "SN1402535" },
        { id: "261", poOrderRef: "LOINC-039408" }, { id: "262", poOrderRef: "LOINC-039408" }
      ] }) });
    }
    return route.fulfill({ contentType: "text/html", body: '<main id="app"><button data-action="ungroup-order" data-order-ref="GOA-9948-9949-9998">Ungroup</button></main>' });
  });
  await page.goto("http://po-identity.test/");
  await page.addScriptTag({ content: `
    const app = document.getElementById('app');
    const group = {id:'GOA-9948-9949-9998',type:'SO',childOrders:['SOA09948','SOA09949','SOA09998']};
    const state = window.testState = {removed:false,retired:[],refresh:[],commits:[],done:0};
    let selectedOrderId='OTHER', selectedOrderIds=new Set(), routeNotice='';
    const DISPATCH_VIEW_MUTATION_ACTIONS=new Set(['ungroup-order']);
    const currentPlanDate='2026-10-15';
    const ensureDispatchPlanEditor=()=>true, orderById=()=>group, saveCurrentPlanNow=async()=>({saved:true});
    const dispatchErrorMessage=async()=> 'Detection failed';
    const ungroupOrder=()=>{state.removed=true;return [{id:'SOA09948'}];};
    const queueGlobalOrderRetirement=ref=>state.retired.push(ref);
    const requestTargetedOrderPoolRefresh=refs=>state.refresh.push(...refs);
    const commitPlanMutation=action=>state.commits.push(action), render=()=>{};
    ${helper}
    const clickHandler=${handler};
    app.addEventListener('click',async event=>{await clickHandler(event);state.done+=1;});
  ` });
  const warnings = [];
  page.once("dialog", async dialog => { warnings.push(dialog.message()); await dialog.dismiss(); });
  await page.click('button[data-action="ungroup-order"]');
  await page.waitForFunction(() => window.testState.done === 1);
  const cancelled = await page.evaluate(() => window.testState);
  assert.equal(cancelled.removed, false);
  assert.deepEqual(cancelled.retired, []);
  assert.deepEqual(cancelled.commits, []);
  page.once("dialog", async dialog => { warnings.push(dialog.message()); await dialog.accept(); });
  await page.click('button[data-action="ungroup-order"]');
  await page.waitForFunction(() => window.testState.done === 2);
  const confirmed = await page.evaluate(() => window.testState);
  assert.equal(confirmed.removed, true);
  assert.deepEqual(confirmed.retired, ["GOA-9948-9949-9998"]);
  assert.deepEqual(confirmed.commits, ["ungroup_order"]);
  assert.ok(confirmed.refresh.includes("SN1402535") && confirmed.refresh.includes("LOINC-039408"));
  assert.equal(requests, 2);
  assert.equal(warnings.length, 2);
  assert.ok(warnings.every(message => /4 PO allocations/.test(message) && /remove all/.test(message)));
  const result = { passed: true, browser: browser.version(), requests, warnings, cancelPreservedGroup: true,
    sourceHash: createHash("sha256").update(source).digest("hex"),
    confirmationQueuedRetirement: true, currentServerAllocationsUsed: true, transport: "isolated fixture" };
  const evidenceFile = `/evidence/browser-${process.pid}.tmp`;
  fs.writeFileSync(evidenceFile, JSON.stringify(result, null, 2) + "\n");
  fs.renameSync(evidenceFile, "/evidence/browser.json");
  console.log(JSON.stringify(result));
  await context.close();
} finally {
  await browser.close();
}
