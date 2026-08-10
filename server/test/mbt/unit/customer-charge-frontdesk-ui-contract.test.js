// @ts-check

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const pageUrl = new URL("../../../public/mbt-frontdesk.html", import.meta.url);
const scriptUrl = new URL("../../../public/mbt-frontdesk.js", import.meta.url);

test("Front Desk customer-charge form exposes the supported request inputs and no per-tonne estimate", async () => {
  const [page, script] = await Promise.all([
    readFile(pageUrl, "utf8"),
    readFile(scriptUrl, "utf8")
  ]);
  for (const id of [
    "paymentMethod",
    "billingAddressText",
    "serviceAddressText",
    "contractTelephone",
    "binContentCode",
    "binDiscountCad",
    "binDiscountReason",
    "aggregateLineEditor",
    "customerChargeDialog",
    "customerChargeSummary"
  ]) {
    assert.match(page, new RegExp(`id=["']${id}["']`, "u"), `${id} must be rendered.`);
  }
  assert.match(page, /<option value="aggregate">Aggregate Order<\/option>/u);
  assert.doesNotMatch(page, /estimated tonnes|per[- ]tonne/iu);
  assert.doesNotMatch(script, /data-line-estimated-tonnes|estimatedTonnes/iu);
});

test("Front Desk reads status before configuration and displays the server gate reason", async () => {
  const script = await readFile(scriptUrl, "utf8");
  assert.match(script, /const status = await api\(["']\/api\/mbt\/frontdesk\/status["']\)/u);
  assert.match(script, /if\s*\(!state\.enabled\)[\s\S]{0,500}status\.message/u);
  assert.match(script, /status\.commandState\?\.reason/u);
});

test("Front Desk explains payment-specific HST and previews all three customer totals", async () => {
  const [page, script] = await Promise.all([
    readFile(pageUrl, "utf8"),
    readFile(scriptUrl, "utf8")
  ]);
  assert.match(page, /Cash prices include HST/iu);
  assert.match(page, /Non-cash prices are before tax/iu);
  for (const label of ["Current contract total", "New request charge", "Resulting contract total", "Due now"]) {
    assert.match(script, new RegExp(label, "u"));
  }
  assert.match(script, /\/api\/mbt\/frontdesk\/charge-requests\/preview/u);
  assert.match(script, /\/charge-requests\/\$\{[^}]+\}\/confirm/u);
  assert.match(script, /customer-charge\/configuration/u);
});

test("priced add-bin and exchange actions replace direct charged exchange submission", async () => {
  const script = await readFile(scriptUrl, "utf8");
  assert.match(script, /openCustomerChargeDialog\([^)]*"add_bin"/u);
  assert.match(script, /openCustomerChargeDialog\([^)]*"exchange_bin"/u);
  assert.doesNotMatch(script, /chargeMode\.append\(new Option\("Charge the change", "charged"\)\)/u);
});

test("each active Front Desk rate-card version is independently selectable", async () => {
  const [page, script] = await Promise.all([
    readFile(pageUrl, "utf8"),
    readFile(scriptUrl, "utf8")
  ]);
  assert.match(page, /Rate card \/ workflow/u);
  assert.match(script, /new Option\([\s\S]{0,250}service\.rateCardVersionId/u);
  assert.match(script, /item\.rateCardVersionId === chargeServiceCode\.value/u);
  assert.match(script, /chargeServiceCode\.addEventListener\("change", syncChargeWorkflowConfiguration\)/u);
  assert.match(script, /loadChargeConfiguration\(service\.rateCardVersionId\)/u);
});
