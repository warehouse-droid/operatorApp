import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { chromium } from "playwright";

test("local VRMA final quantity confirmation works in a browser and can be cancelled", async () => {
  const source = await readFile(new URL("../../../public/operator.js", import.meta.url), "utf8");
  const dialogSource = source.slice(source.indexOf("let loadPartialConfirmation = null;"), source.indexOf("async function pollFulfillmentJob("));
  const browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
  try {
    const page = await browser.newPage({ viewport: { width: 900, height: 650 } });
    await page.setContent('<!doctype html><html><head><title>Load confirmation</title></head><body></body></html>');
    await page.addStyleTag({ path: "public/operator.css" });
    await page.addScriptTag({ content: `function escapeHtml(value) { return String(value).replaceAll('<','&lt;'); }\n${dialogSource}` });
    await page.evaluate(() => {
      window.loadResult = null;
      void confirmMissingLoadLines([{ orderRef: "LOCAL-VRMA", total: 1, confirmed: 1, missing: [], finalizesEstimatedQuantity: true }])
        .then(result => { window.loadResult = result; });
    });
    const dialog = page.locator("dialog[open]");
    assert.match(await dialog.innerText(), /loaded quantity becomes final/);
    assert.match(await dialog.innerText(), /remaining estimated quantity.*abandoned/);
    await page.screenshot({ path: "test-artifacts/vrma-final-confirmation.png" });
    await page.getByRole("button", { name: "Go back" }).click();
    assert.equal(await page.evaluate(() => window.loadResult), false);
    assert.equal(await page.locator("dialog").count(), 0);
  } finally { await browser.close(); }
});
