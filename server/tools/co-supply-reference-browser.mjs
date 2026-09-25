/* global window, document */
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { parse } from "espree";
import { chromium } from "@playwright/test";
import { withTransaction, closeDb } from "../src/db.js";
import { referenceCo } from "../test/support/co-supply-reference-fixture.mjs";
import { getDeliveryOrder, listDeliveryOrders } from "../src/delivery-repository.js";

const folder = "test-artifacts/co-supply-reference";
const source = await readFile("public/operator.js", "utf8");
const ast = parse(source, { ecmaVersion: "latest", sourceType: "module", range: true }).body;
const functions = ast.filter(node => node.type === "FunctionDeclaration").map(node => source.slice(...node.range)).join("\n");
const translation = ast.find(node => node.type === "VariableDeclaration" && node.declarations[0]?.id.name === "t");
let browser;
try {
  await withTransaction(async () => {
    const f = await referenceCo();
    const detail = await getDeliveryOrder(f.co.co_ref);
    browser = await chromium.launch({ args: ["--no-sandbox"] });
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await page.setContent(`<style>${await readFile("public/operator.css", "utf8")}</style><main id="rows"></main><section id="panel"></section>`);
    await page.addScriptTag({ content: source.slice(...translation.range) + "\n" + functions });
    await page.evaluate(order => Object.assign(window, {
      PICKABLE_ITEM_TYPES: new Set(["InvtPart", "NonInvtPart"]), LOAD_SALES_QTY_TOLERANCE: 0.1,
      currentModule: "delivery", operator: { id: "browser-test" }, selectedOrder: order,
      selectedLineId: null, compactLineMode: false, pageConfirming: false, pickupConfirming: false
    }), detail);
    const results = [];
    for (const mode of ["packed", "active"]) {
      const cards = await listDeliveryOrders({ locationId: 26, status: mode, orderType: "sales_order" });
      assert.ok(cards.some(row => row.tranid === f.co.co_ref));
      const result = await page.evaluate(({ order, view }) => {
        window.viewMode = view;
        const lines = window.visibleLines(order);
        document.getElementById("rows").innerHTML = lines.map(window.renderLine).join("");
        return lines.map(row => ({ item: Number(row.item_id), quantity: Number(row.quantity) }));
      }, { order: detail, view: mode });
      if (mode === "packed") {
        assert.equal(result.length, 5);
        assert.ok(result.every(row => row.item !== 1356 && row.item !== 1784));
      } else {assert.deepEqual(result, [{ item: 1356, quantity: 0 }, { item: 1784, quantity: 6 }]);}
      await page.screenshot({ path: `${folder}/operator-${mode}.png` });
      results.push({ mode, cardVisible: true, lines: result });
    }
    const reference = detail.lines.find(row => Number(row.item_id) === 1356);
    assert.match(await page.locator(`[data-line="${reference.id}"]`).innerText(), /No yard load required—direct supply/u);
    await page.evaluate(row => { document.getElementById("panel").innerHTML = window.renderSelectedLinePanel(row); }, reference);
    assert.match(await page.locator("#panel").innerText(), /No yard load required/u);
    assert.equal(await page.locator("#panel [data-action]").count(), 0);
    assert.deepEqual(await page.locator("#panel .linked-supply-breakdown b").allTextContents(), ["52.25 SQFT", "- SQFT", "52.25 SQFT", "- SQFT"]);
    await page.screenshot({ path: `${folder}/operator-reference.png` });
    const pallet = detail.lines.find(row => Number(row.item_id) === 1784);
    await page.evaluate(row => { document.getElementById("panel").innerHTML = window.renderSelectedLinePanel(row); }, pallet);
    assert.equal(await page.locator('#panel [data-action="confirm-line"]').count(), 1);
    assert.ok(await page.locator('#panel [data-action="step-qty"]').count() > 0);
    await page.screenshot({ path: `${folder}/operator-residual-pallet.png` });
    const report = { views: results, referenceNotice: true, referencePackingControls: 0, palletPackable: true };
    await writeFile(`${folder}/browser.json`, JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report));
  }, { rollback: true });
} finally {await browser?.close(); await closeDb();}
