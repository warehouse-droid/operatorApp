import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import http from "node:http";
import test from "node:test";
import { chromium } from "@playwright/test";

/* global orders, normalizeOrder, orderCatalog, trucks, fleet, currentPlanDate, currentPlan, compactCurrentPlan,
dispatchConfig, dispatchSetupLoaded, dispatchPlannerSnapshotState, planEditMode, planEditLeaseToken, planEditLease,
dispatchSessionId, lastAcknowledgedPlanState, dispatchPlanWireState, markLocalPlanDirty, savePlanToServer,
planPayload, renderDispatchNoticePatch, resetLocalPlanDirty */

// A save the server rejects keeps the draft and every autosave repeats the
// rejection. The notice must offer a way out instead of only the error text.
async function rejectedSaveCase(rejection, run) {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    if (url.pathname.endsWith(".js")) {
      res.setHeader("Content-Type", "text/javascript");
      res.end(await readFile(new URL(`../../../public${url.pathname}`, import.meta.url))); return;
    }
    if (!url.pathname.startsWith("/api/")) {
      res.setHeader("Content-Type", "text/html");
      res.end('<!doctype html><main id="dispatchApp"></main><script>function requireDispatchLogin() {}</script><script src="/dispatch-edit-activity.js"></script><script src="/dispatch.js"></script>'); return;
    }
    for await (const _chunk of req) { /* drain */ }
    res.setHeader("Content-Type", "application/json");
    if (url.pathname.endsWith("/plans/rejected-plan") || url.pathname.endsWith("/plans/rejected-plan/commands")) {
      res.statusCode = rejection.status;
      res.end(JSON.stringify(rejection.body)); return;
    }
    res.end("{}");
  });
  let browser;
  try {
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
    const page = await browser.newPage();
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.evaluate(() => {
      orders = [normalizeOrder({ id: "SOX1", type: "SO", customer: "X", address: "1 X Street", pickupLocations: ["3445"],
        items: [{ sku: "X", quantity: 1 }] })];
      orderCatalog = structuredClone(orders);
      trucks = [{ id: "RJ-TRUCK", plate: "RJ", name: "Rejected", base: "3445", loads: [{ id: "RJ-LOAD", name: "Load 1",
        stops: [{ id: "drop", type: "drop", orderId: "SOX1", location: "1 X Street" }] }] }];
      fleet = structuredClone(trucks);
      const plan = { id: "rejected-plan", planDate: "2099-11-05", revision: 4, digest: "d", status: "draft", orders, trucks };
      currentPlanDate = plan.planDate; currentPlan = compactCurrentPlan(plan);
      dispatchConfig = { plannerOrderPoolMode: "off", plannerCommandMode: "off", googleMapsEnabled: false };
      dispatchSetupLoaded = true; dispatchPlannerSnapshotState = "ready";
      planEditMode = true; planEditLeaseToken = "synthetic-token";
      planEditLease = { active: true, sessionId: dispatchSessionId, planDate: currentPlanDate };
      lastAcknowledgedPlanState = dispatchPlanWireState(plan);
      document.getElementById("dispatchApp").innerHTML = "<div data-dispatch-route-notice></div>";
    });
    await run(page);
    assert.deepEqual(errors, []);
  } finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); }
}

const rejectAndRender = page => page.evaluate(async () => {
  markLocalPlanDirty();
  await savePlanToServer(planPayload(new Date(), { draftOnly: true }));
  renderDispatchNoticePatch();
  const notice = document.querySelector("[data-dispatch-route-notice]");
  const actions = [...notice.querySelectorAll("button[data-action]")].map(button => button.dataset.action);
  resetLocalPlanDirty();
  renderDispatchNoticePatch();
  const after = [...notice.querySelectorAll("button[data-action]")].map(button => button.dataset.action);
  return { text: notice.textContent, actions, after };
});

test("a recovery-saved rejection offers undo and discard", () => rejectedSaveCase({ status: 202, body: {
  applied: false, recoveryDraft: { id: "draft-1" },
  validationIssues: [{ message: "GOA-1 does not require pickup at 2967." }] } }, async page => {
  const state = await rejectAndRender(page);
  assert.match(state.text, /Draft backed up separately/u);
  assert.ok(state.actions.includes("undo-plan"));
  assert.ok(state.actions.includes("discard-rejected-plan-changes"));
  assert.ok(!state.after.includes("discard-rejected-plan-changes"));
}));

test("a business-conflict rejection offers undo and discard", () => rejectedSaveCase({ status: 409, body: {
  code: "ORDER_DEPENDENCY_STRUCTURE_LOCK", error: "Ungroup is locked by TO-1." } }, async page => {
  const state = await rejectAndRender(page);
  assert.match(state.text, /locked by TO-1/u);
  assert.ok(state.actions.includes("undo-plan"));
  assert.ok(state.actions.includes("discard-rejected-plan-changes"));
}));

test("discarding reloads the saved plan through the normal plan loader", async () => {
  const source = await readFile(new URL("../../../public/dispatch.js", import.meta.url), "utf8");
  const handler = source.slice(source.indexOf('if (action === "discard-rejected-plan-changes")'));
  assert.ok(source.includes('if (action === "discard-rejected-plan-changes")'));
  assert.match(handler.slice(0, 1200), /resetLocalPlanDirty\(\)[\s\S]*loadPlanForDate\(currentPlanDate, \{ createIfMissing: false \}\)/u);
});
