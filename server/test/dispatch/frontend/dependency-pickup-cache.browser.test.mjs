import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import http from "node:http";
import test from "node:test";
import { chromium } from "@playwright/test";
import { cacheFixture, groupRef } from "../../support/dependency-pickup-cache-fixture.mjs";
import { validateDispatchPickupVisits } from "../../../src/dispatch-pickup-visits.js";

/* Browser globals referenced inside Playwright page.evaluate callbacks. */
/* global orders, normalizeOrder, orderCatalog, trucks, fleet, currentPlanDate, currentPlan,
compactCurrentPlan, dispatchConfig, dispatchSetupLoaded, dispatchPlannerSnapshotState,
planEditMode, planEditLeaseToken, planEditLease, dispatchSessionId, lastAcknowledgedPlanState,
dispatchPlanWireState, selectedOrderId, selectedLoadId, applySavedPlan, normalizePlanBeforeSave,
applyAtomicDependencyMutationPayload, localPlanGeneration, markLocalPlanDirty, saveCurrentPlanNow,
routeNotice, localPlanDirty, savePlanToServer, planPayload, blockedPlanSaveFence */

async function browserCase(run) {
  const fixture = cacheFixture(), saves = [], errors = [];
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    res.setHeader("Content-Type", "application/json");
    if (url.pathname.endsWith(".js")) {
      res.setHeader("Content-Type", "text/javascript");
      res.end(await readFile(new URL(`../../../public${url.pathname}`, import.meta.url))); return;
    }
    if (!url.pathname.startsWith("/api/")) {
      res.setHeader("Content-Type", "text/html");
      res.end('<!doctype html><main id="dispatchApp"></main><script>function requireDispatchLogin() {}</script><script src="/dispatch-edit-activity.js"></script><script src="/dispatch.js"></script>'); return;
    }
    let body = "";
    for await (const chunk of req) body += chunk;
    const request = body ? JSON.parse(body) : {};
    const incremental = url.pathname.endsWith("/plans/cache-plan/commands");
    const payload = incremental ? { ...request.payload, baseRevision: request.baseRevision, baseDigest: request.baseDigest } : request;
    if (incremental || (req.method === "PUT" && url.pathname.endsWith("/plans/cache-plan"))) {
      saves.push(payload);
      const issues = validateDispatchPickupVisits({ ...payload, orders: fixture.after.orders });
      if (issues.length) {
        res.statusCode = 202;
        res.end(JSON.stringify({ applied: false, recoveryDraft: { id: "recovery", reason: issues[0].message } }));
      } else {
        const plan = { ...payload, id: "cache-plan", revision: 3, digest: "saved", status: "draft" };
        res.end(JSON.stringify(incremental ? { plan } : plan));
      }
      return;
    }
    res.end(JSON.stringify({}));
  });
  let browser;
  try {
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
    const page = await browser.newPage();
    page.on("pageerror", error => errors.push(error.message));
    if (process.env.DEPENDENCY_CACHE_COVERAGE_DIR) await page.coverage.startJSCoverage();
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.evaluate(({ before }) => {
      orders = before.orders.map(normalizeOrder); orderCatalog = structuredClone(orders);
      trucks = structuredClone(before.trucks); fleet = structuredClone(before.trucks);
      currentPlanDate = before.planDate; currentPlan = compactCurrentPlan(before);
      dispatchConfig = { plannerOrderPoolMode: "off", plannerCommandMode: "off", googleMapsEnabled: false };
      dispatchSetupLoaded = true; dispatchPlannerSnapshotState = "ready";
      planEditMode = true; planEditLeaseToken = "synthetic-token";
      planEditLease = { active: true, sessionId: dispatchSessionId, planDate: currentPlanDate };
      lastAcknowledgedPlanState = dispatchPlanWireState({ ...before, orders: structuredClone(orders), trucks: structuredClone(trucks) });
      selectedOrderId = before.orders[0].id; selectedLoadId = before.trucks[0].loads[0].id;
    }, fixture);
    await run(page, fixture, saves);
    assert.deepEqual(errors, []);
    if (process.env.DEPENDENCY_CACHE_COVERAGE_DIR) {
      const result = (await page.coverage.stopJSCoverage()).filter(entry => entry.url.endsWith("/dispatch.js"))
        .map(entry => ({ ...entry, url: new URL("../../../public/dispatch.js", import.meta.url).href }));
      await writeFile(`${process.env.DEPENDENCY_CACHE_COVERAGE_DIR}/browser-${Date.now()}.json`, JSON.stringify({ result }));
    }
  } finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); }
}

test("applying a saved plan cannot revive a cancelled pickup from the browser catalogue", () => browserCase(async (page, { after }) => {
  const result = await page.evaluate(saved => {
    applySavedPlan(saved);
    normalizePlanBeforeSave();
    return { orders, trucks };
  }, after);
  assert.deepEqual(result.orders[0].orderDependencies || [], []);
  assert.deepEqual(result.orders[0].directPickupManifest || [], []);
  assert.deepEqual(result.orders[0].childOrderDetails[0].orderDependencies || [], []);
  assert.deepEqual(validateDispatchPickupVisits({ ...result, orders: after.orders }), []);
  assert.equal(result.trucks[0].loads[0].stops.some(stop => stop.location === "2967"), false);
}));

test("unlink acknowledgement followed by a real browser save keeps the pickup removed", () => browserCase(async (page, { after }, saves) => {
  const state = await page.evaluate(async saved => {
    applyAtomicDependencyMutationPayload({ plan: saved, orders: saved.orders }, { generation: localPlanGeneration });
    orders[0].notes = "Preserve dispatch note"; markLocalPlanDirty();
    await saveCurrentPlanNow();
    return { routeNotice, localPlanDirty, currentPlan };
  }, after);
  assert.equal(saves.length, 1);
  assert.equal(saves[0].baseRevision, 2);
  assert.deepEqual(validateDispatchPickupVisits({ ...saves[0], orders: after.orders }), []);
  assert.equal(saves[0].orders.find(order => order.id === groupRef).notes, "Preserve dispatch note");
  assert.equal(state.localPlanDirty, false);
  assert.doesNotMatch(state.routeNotice, /backed up separately/);
}));

test("an unrelated edit in flight survives while the new dependency pickup state is adopted", () => browserCase(async (page, { after }, saves) => {
  const state = await page.evaluate(async saved => {
    const generation = localPlanGeneration;
    orders[0].notes = "Newer local edit"; markLocalPlanDirty();
    const applied = applyAtomicDependencyMutationPayload({ plan: saved, orders: saved.orders }, { generation });
    await saveCurrentPlanNow();
    return { applied, currentPlan, routeNotice };
  }, after);
  assert.equal(state.applied, true);
  assert.equal(saves.length, 1);
  assert.equal(saves[0].baseRevision, 2);
  assert.equal(saves[0].orders[0].notes, "Newer local edit");
  assert.deepEqual(validateDispatchPickupVisits({ ...saves[0], orders: after.orders }), []);
  assert.doesNotMatch(state.routeNotice, /backed up separately/);
}));

test("conflicting edits in flight retain the local draft and cannot advance the save fence", () => browserCase(async (page, { after }, saves) => {
  const state = await page.evaluate(async saved => {
    const generation = localPlanGeneration;
    trucks[0].loads[0].stops[1].location = "150"; markLocalPlanDirty();
    const applied = applyAtomicDependencyMutationPayload({ plan: saved }, { generation });
    const save = await savePlanToServer(planPayload(new Date(), { draftOnly: true }));
    return { applied, save, currentPlan, lastAcknowledgedPlanState, trucks, blockedPlanSaveFence, localPlanDirty };
  }, after);
  assert.equal(state.applied, false);
  assert.equal(state.currentPlan.revision, 1);
  assert.equal(state.lastAcknowledgedPlanState.revision, 1);
  assert.equal(state.localPlanDirty, true);
  assert.equal(state.trucks[0].loads[0].stops.some(stop => stop.location === "150"), true);
  assert.ok(state.blockedPlanSaveFence);
  assert.equal(saves.length, 0);
}));

for (const scenario of ["missing baseline", "changed membership"]) {
  test(`an in-flight response with ${scenario} retains the draft for review`, () => browserCase(async (page, { after }, saves) => {
    const state = await page.evaluate(({ saved, scenario }) => {
      const generation = localPlanGeneration;
      orders[0].notes = "Keep this draft"; markLocalPlanDirty();
      if (scenario === "missing baseline") lastAcknowledgedPlanState = null;
      else saved.orders.push({ id: "NEW-SERVER-ORDER", type: "SO" });
      const applied = applyAtomicDependencyMutationPayload({ plan: saved }, { generation });
      return { applied, revision: currentPlan.revision, notes: orders[0].notes, fence: blockedPlanSaveFence };
    }, { saved: after, scenario });
    assert.equal(state.applied, false);
    assert.equal(state.revision, 1);
    assert.equal(state.notes, "Keep this draft");
    assert.ok(state.fence);
    assert.equal(saves.length, 0);
  }));
}
