// @ts-check

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const [page, script] = await Promise.all([
  readFile(new URL("../../../public/mbt-config.html", import.meta.url), "utf8"),
  readFile(new URL("../../../public/mbt-shell.js", import.meta.url), "utf8")
]);

test("item settings and rate cards replace the duplicate hard-coded customer-charge sheet", () => {
  assert.doesNotMatch(page, /id=["']customerChargesTab["']/u);
  assert.doesNotMatch(page, /id=["']customerChargesPanel["']/u);
  assert.doesNotMatch(page, /data-aggregate-charge-code/u);
  assert.doesNotMatch(page, /data-fixed-dump-charge-code/u);
  assert.match(page, /<option value=["']aggregate["']>Aggregate<\/option>/u);
  assert.match(page, /id=["']customLocalItemChargeBasis["']/u);
  assert.match(page, /id=["']customLocalItemDensityLbsPerYard["']/u);
  assert.match(page, /id=["']localItemChargeBasis["']/u);
});

test("the normal rate-card editor owns per-yard aggregate and per-bin dump prices", () => {
  assert.match(script, /case ["']aggregate["']/u);
  assert.match(script, /unitOfMeasure:\s*["']YARD["']/u);
  assert.match(script, /unitOfMeasure:\s*fixedPerBin\s*\?\s*["']BIN["']\s*:\s*["']TONNE["']/u);
  assert.match(script, /itemType === ["']aggregate["'][\s\S]{0,100}\[["']delivery["'], ["']exchange["']\]/u);
  assert.match(script, /chargeBasis/u);
  assert.doesNotMatch(script, /readinessElement\(["']customerChargeConfigurationForm["']\)/u);
});
