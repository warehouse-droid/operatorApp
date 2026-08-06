import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const [html, client] = await Promise.all([
  readFile(new URL("../../../public/mbt-config.html", import.meta.url), "utf8"),
  readFile(new URL("../../../public/mbt-shell.js", import.meta.url), "utf8")
]);

test("dump sites select local dump items and expose explicit create/update controls", () => {
  for (const id of [
    "newDumpSiteButton",
    "dumpSiteEditorMode",
    "dumpSiteItemAcceptances",
    "dumpSiteActive"
  ]) {
    assert.match(html, new RegExp(`id=["']${id}["']`, "u"));
  }
  assert.match(html, /id=["']dumpSiteItemAcceptances["'][^>]*data-dump-acceptance-items/u);
  assert.match(html, /id=["']dumpSiteRevision["'][^>]*type=["']hidden["']/u);
  assert.match(client, /function\s+newDumpSiteEditor\s*\(/u);
  assert.match(client, /renderDumpSiteAcceptanceOptions/u);
  assert.match(client, /dumpSiteActive[\s\S]*site\.active/u,
    "Editing a dump site must preserve its active state rather than silently reactivating it.");
  const dumpSiteRenderer = client.slice(
    client.indexOf("function renderDumpSiteList"),
    client.indexOf("async function saveDumpSite")
  );
  assert.match(
    dumpSiteRenderer,
    /editingDumpSiteCode\s*=\s*site\.dumpSiteCode[\s\S]*renderDumpSiteAcceptanceOptions\(site\)/u,
    "Editing a dump site must load all selected dump-item acceptances before rendering its toggles."
  );
  assert.doesNotMatch(html, /id=["']materialForm["']/u);
});

test("multi-item rate cards expose price-sheet yard, boundary, and charge-basis options without raw JSON", () => {
  assert.match(html, /Pricing item/u);
  assert.match(html, /multiple local items/i);
  assert.match(client, /BIN delivery/u);
  assert.match(client, /MBBS cross charge/u);
  assert.match(client, /Add distance band/u);
  assert.match(client, /From kilometres.*exclusive after the first/u);
  assert.match(client, /To kilometres.*inclusive/u);
  assert.match(client, /originYardCodes/u);
  assert.match(client, /pricingBasis/u);
  assert.match(client, /CAD per kilometre/u);
  assert.match(client, /upper_inclusive/u);
  assert.match(client, /CAD \/ tonne/u);
  assert.match(client, /Remove/u);
  assert.match(client, /function\s+renderRateItemEditor\s*\(/u);
  assert.match(client, /item\.itemType/u);
  assert.doesNotMatch(client, /requiredRateMaterialCode/u);
});

test("a selected rate card loads a named draft editor and saves through optimistic update", () => {
  assert.match(html, /Create new rate card/u);
  assert.match(html, /Edit selected rate/u);
  assert.match(html, /id=["']rateCardRows["']/u);
  assert.doesNotMatch(html, /<pre[^>]+id=["']rateCardsSummary["']/u);
  assert.match(client, /loadRateCardForEdit/u);
  assert.match(client, /populateSimplifiedRateEditor/u);
  assert.match(client, /method:\s*editing\s*\?\s*["']PUT["']\s*:\s*["']POST["']/u);
  assert.match(client, /expectedRevision/u);
  const saveStart = client.indexOf("async function saveRateCardDraft");
  const saveEnd = client.indexOf("async function runRateCardLifecycle", saveStart);
  assert.ok(saveStart >= 0 && saveEnd > saveStart);
  const saveDraft = client.slice(saveStart, saveEnd);
  assert.match(
    saveDraft,
    /upsertRateCardVersion\(result\.version/u,
    "A successful mutation must render its returned version immediately."
  );
  assert.doesNotMatch(saveDraft, /await\s+loadRateCards\(/u,
    "A follow-up list refresh must not turn a committed save into a false failure.");
  const newEditorStart = client.indexOf("function newRateCardEditor");
  const newEditorEnd = client.indexOf("function simplifiedRateCardGraph", newEditorStart);
  assert.ok(newEditorStart >= 0 && newEditorEnd > newEditorStart);
  const newEditor = client.slice(newEditorStart, newEditorEnd);
  assert.match(newEditor, /initializeItemPricingState/u);
  assert.match(newEditor, /activateRatePricingItem/u);
  assert.doesNotMatch(newEditor, /rental14ydCad/u);
});

test("successful local item creation renders the returned entity without requiring refresh", () => {
  const saveStart = client.indexOf("async function saveCustomLocalItem");
  const saveEnd = client.indexOf("function localImportControls", saveStart);
  assert.ok(saveStart >= 0 && saveEnd > saveStart);
  const saveItem = client.slice(saveStart, saveEnd);
  assert.match(saveItem, /upsertLocalItem\(result\.entities\?\.\[0\]/u);
  assert.doesNotMatch(saveItem, /await\s+loadLocalItems\(/u);
  assert.match(saveItem, /localItemSaveInFlight/u);
});
