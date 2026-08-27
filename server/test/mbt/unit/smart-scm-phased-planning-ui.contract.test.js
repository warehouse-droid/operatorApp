import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const publicUrl = new URL("../../../public/", import.meta.url);
const page = fs.readFileSync(new URL("scm-smart.html", publicUrl), "utf8");
const settingsClient = fs.readFileSync(new URL("scm-smart.js", publicUrl), "utf8");
const proposalsClient = fs.readFileSync(new URL("scm-smart-proposals.js", publicUrl), "utf8");
const forecastRepository = fs.readFileSync(
  new URL("../../../src/smart-scm-forecast-repository.js", import.meta.url),
  "utf8"
);

test("Smart SCM exposes independent skip-12441 and inventory planning-mode settings", () => {
  assert.match(settingsClient, /skip12441Enabled/);
  assert.match(settingsClient, /inventoryPlanningMode/);
  assert.match(settingsClient, /Integrated — current one-pass behavior/);
  assert.match(settingsClient, /Phased — approve PO, then calculate Transfer/);
  assert.match(settingsClient, /Skipped by Smart SCM setting/);
  assert.match(settingsClient, /Saved policy values are retained and become effective again/);
  assert.match(forecastRepository, /smartScmApplySkip12441Policy/);
  assert.match(forecastRepository, /coverageFloorPallets: skip12441Effective \? 0/);
  assert.match(forecastRepository, /zeroDemandCoverageApplied: skip12441Effective \? false/);
});

test("PO-then-transfer requires an explicit visible approval before Phase 2", () => {
  assert.match(proposalsClient, /data-smart-planning-phase="po_pending_approval"/);
  assert.match(proposalsClient, /data-smart-action="approve-po-phase"/);
  assert.match(proposalsClient, /Only real active NetSuite POs and active local split references/);
  assert.match(proposalsClient, /\/api\/scm\/smart\/planning-runs\/\$\{smartState\.plan\.id\}\/approve-po-phase/);
  assert.match(proposalsClient, /The PO evidence used for this run is frozen/);
});

test("the Smart SCM page cache-busts both changed clients", () => {
  assert.match(page, /scm-smart\.js\?v=20260826-phased-planning-v1/);
  assert.match(page, /scm-smart-proposals\.js\?v=20260826-phased-planning-v1/);
});
