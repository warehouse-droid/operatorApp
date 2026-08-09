// @ts-check

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const [page, script] = await Promise.all([
  readFile(new URL("../../../public/mbt-config.html", import.meta.url), "utf8"),
  readFile(new URL("../../../public/mbt-shell.js", import.meta.url), "utf8")
]);

test("admin configuration exposes all four aggregate and three fixed-dump real-rate inputs", () => {
  for (const id of [
    "customerChargesTab",
    "customerChargesPanel",
    "customerChargeRateCardVersion",
    "aggregateChargeRateRows",
    "fixedDumpChargeRateRows",
    "aggregateDistanceBandRows",
    "addAggregateDistanceBandButton",
    "customerChargeConfigurationForm",
    "customerChargeConfigurationReason"
  ]) {
    assert.match(page, new RegExp(`id=["']${id}["']`, "u"), `${id} must be rendered.`);
  }
  for (const label of [
    "3/4 Clear Limestone",
    "Crusher Run",
    "HPB",
    "Screening",
    "Soil fixed dump charge",
    "Asphalt fixed dump charge",
    "Concrete fixed dump charge"
  ]) {
    assert.match(page, new RegExp(label.replace("/", "\\/"), "u"));
  }
  assert.match(page, /CAD 150[^<]*through 30 km/iu);
  assert.match(page, /CAD 50[^<]*loading fee/iu);
});

test("admin configuration reads and saves one audited optimistic customer-charge sheet", () => {
  assert.match(script, /\/api\/mbt\/config\/customer-charges\/\$\{[^}]+\}/u);
  assert.match(script, /expectedRevision/u);
  assert.match(script, /aggregateItems/u);
  assert.match(script, /fixedDumpItems/u);
  assert.match(script, /aggregateDistanceBands/u);
  assert.match(script, /idempotencyKey/u);
});
