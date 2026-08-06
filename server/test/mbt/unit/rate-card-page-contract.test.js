import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const [html, client, css] = await Promise.all([
  readFile(new URL("../../../public/mbt-config.html", import.meta.url), "utf8"),
  readFile(new URL("../../../public/mbt-shell.js", import.meta.url), "utf8"),
  readFile(new URL("../../../public/mbt-shell.css", import.meta.url), "utf8")
]);

test("P3-F12 browser contract: Rate Cards is an accessible local draft lifecycle surface", () => {
  assert.match(html, /id=["']rateCardsTab["'][\s\S]{0,180}role=["']tab["']/i);
  assert.match(html, /id=["']rateCardsTab["'][\s\S]{0,260}aria-controls=["']rateCardsPanel["']/i);
  assert.match(
    html,
    /id=["']rateCardsPanel["'][\s\S]{0,220}role=["']tabpanel["'][\s\S]{0,160}aria-labelledby=["']rateCardsTab["']/i
  );
  assert.match(html, /Rate Cards/i);
  for (const action of [
    /Save draft/i,
    /Validate draft/i,
    /Activate version/i,
    /Clone as new draft/i
  ]) {
    assert.match(html, action, `P3.6 requires the visible rate-card action: ${action}.`);
  }
  assert.match(html, /aria-live=["']polite["']/i);
  assert.match(css, /\.mbt-rate-card/i);
});

test("P3-F12/P4 browser contract: manual setup uses business units while retaining advanced CSV", () => {
  for (const field of [
    /Rate card code/i,
    /Effective from/i,
    /Pricing item/i,
    /charging mechanism/i,
    /Edit selected rate/i,
    /Audit reason/i
  ]) {
    assert.match(html, field, `P3.6 requires an explicit rate-card editor field: ${field}.`);
  }
  for (const fileName of [
    "rate_cards.csv",
    "distance_bands.csv",
    "components.csv",
    "dump_tariffs.csv",
    "deposit_rules.csv"
  ]) {
    assert.match(html, new RegExp(fileName.replace(".", "\\."), "i"));
  }
  assert.match(html, /type=["']file["'][^>]+accept=["'][^"']*\.csv/i);
  assert.match(html, /Preview complete graph/i);
  assert.match(client, /inputType:\s*["']number["'][\s\S]{0,80}step:\s*["']0\.01["']/i);
});

test("P3-F12 browser contract: the client is no-store, local-only, and preserves active editor focus", () => {
  assert.match(client, /\/api\/mbt\/config\/rate-cards/);
  assert.match(client, /cache:\s*["']no-store["']/);
  assert.doesNotMatch(client, /\/api\/(?:scm|dispatch|driver|operator)\//);
  assert.match(client, /document\.activeElement/);
  assert.match(client, /selectionStart/);
  assert.match(client, /selectionEnd/);
  assert.match(client, /setSelectionRange\s*\(/);
  assert.match(client, /rateCardsPanel|rateCardEditor/);
});
