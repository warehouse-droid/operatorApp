import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const [html, script, styles] = await Promise.all([
  readFile(new URL("../../../public/mbt-config.html", import.meta.url), "utf8"),
  readFile(new URL("../../../public/mbt-shell.js", import.meta.url), "utf8"),
  readFile(new URL("../../../public/mbt-shell.css", import.meta.url), "utf8")
]);

test("LC08: Local Item Settings is the first selected configuration tab", () => {
  const localTabIndex = html.indexOf('id="localItemSettingsTab"');
  const netSuiteTabIndex = html.indexOf('id="netSuiteReadinessTab"');
  assert.ok(localTabIndex >= 0);
  assert.ok(netSuiteTabIndex > localTabIndex);
  assert.match(
    html,
    /id="localItemSettingsTab"[\s\S]{0,250}role="tab"[\s\S]{0,250}aria-selected="true"/
  );
  assert.match(
    html,
    /id="netSuiteReadinessTab"[\s\S]{0,250}aria-selected="false"/
  );
  assert.match(html, /id="localItemSettingsPanel"[\s\S]{0,200}role="tabpanel"/);
  assert.match(html, /id="netSuiteReadinessPanel"[\s\S]{0,200}hidden/);
});

test("LC03-R1/LC08: the local editor has no duplicate money, UOM, or NetSuite identity input", () => {
  const panel = html.match(/id="localItemSettingsPanel"([\s\S]*?)id="netSuiteReadinessPanel"/)?.[1] || "";
  assert.match(panel, /id="localItemRows"/);
  assert.match(panel, /id="localItemDisplayName"/);
  assert.match(panel, /id="localItemDescription"/);
  assert.match(panel, /id="localItemActive"/);
  assert.match(panel, /id="localItemReason"/);
  assert.doesNotMatch(panel, /defaultUnitAmount|unitOfMeasure|netSuiteItemId|mappingExternalId/);
  assert.match(panel, /Calculated|Rate card|Custom price/i);
});

test("LC08/LC09: local setup loads independently and NetSuite readiness is lazy", () => {
  assert.match(script, /api\(["']\/api\/mbt\/config\/local\/items["']/);
  assert.match(script, /async function loadLocalItems\(/);
  assert.match(script, /async function ensureReadinessLoaded\(/);
  assert.match(script, /netSuiteReadinessTab[\s\S]{0,900}ensureReadinessLoaded/);
  const loadFunction = script.match(/async function load\(\)\s*\{([\s\S]*?)\n\}/)?.[1] || "";
  assert.match(loadFunction, /loadLocalItems/);
  assert.doesNotMatch(loadFunction, /loadReadiness|config\/netsuite|preflight/);
});

test("LC05/LC08: the local editor prevents double-submit and tabs support keyboard navigation", () => {
  assert.match(script, /localItemSaveInFlight/);
  assert.match(script, /if\s*\(localItemSaveInFlight\)/);
  assert.match(script, /ArrowLeft|ArrowRight/);
  assert.match(script, /Home/);
  assert.match(script, /End/);
  assert.match(script, /textContent/);
  assert.match(styles, /\.mbt-local-items/);
});
