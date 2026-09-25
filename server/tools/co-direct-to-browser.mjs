/* global window, document */
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { parse } from "espree";
import { chromium } from "@playwright/test";
import { query, withTransaction, closeDb } from "../src/db.js";
import { seed, sourceCo, command } from "../test/support/co-direct-to-fixture.mjs";
import { executeScmDependencyCommand, scmDependencyPayloadHash } from "../src/scm-dependency-command-service.js";
import { getDeliveryOrder, listDeliveryOrders } from "../src/delivery-repository.js";

const folder = "test-artifacts/co-direct-to";
const source = await readFile("public/operator.js", "utf8");
const functions = parse(source, { ecmaVersion: "latest", sourceType: "module", range: true }).body
  .filter(node => node.type === "FunctionDeclaration").map(node => source.slice(...node.range)).join("\n");
let browser;
try {
  await withTransaction(async () => {
    const f = await seed();
    const co = await sourceCo(f);
    for (let i = 3; i <= 7; i += 1) {
      await query(`INSERT INTO local_co_order_lines (co_id,line_id,item_id,item_name,sku,item_type,
        quantity,piece_qty,to_pcs,unit,packed_piece_qty,confirmed_at)
        VALUES ($1,$2,$2,'Packed wall','WALL','InvtPart',10,10,1,'PC',10,now())`, [co.id, i]);
    }
    const c = await command(f);
    c.payload.allocations.push({ salesLineId: f.palletId, quantities: { salesQty: 1 } });
    c.payloadHash = scmDependencyPayloadHash(c);
    await executeScmDependencyCommand(c);
    const detail = await getDeliveryOrder(co.co_ref);
    browser = await chromium.launch({ args: ["--no-sandbox"] });
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await page.setContent(`<style>${await readFile("public/operator.css", "utf8")}</style><main id="rows"></main>`);
    await page.addScriptTag({ content: functions });
    await page.evaluate(() => Object.assign(window, {
      PICKABLE_ITEM_TYPES: new Set(["InvtPart", "NonInvtPart"]), LOAD_SALES_QTY_TOLERANCE: 0.1,
      currentModule: "delivery", operator: { id: "browser-test" }
    }));
    const results = [];
    for (const mode of ["packed", "active"]) {
      const cards = await listDeliveryOrders({ locationId: 26, status: mode, orderType: "sales_order" });
      assert.ok(cards.some(row => row.tranid === co.co_ref));
      const result = await page.evaluate(({ order, view }) => {
        window.viewMode = view;
        const lines = window.visibleLines(order);
        document.getElementById("rows").innerHTML = `<h2>${order.tranid} — ${view}</h2>`
          + lines.map(line => `<p data-line="${line.id}">${line.sku || line.item_name}: ${line.quantity} ${line.unit}</p>`).join("");
        return lines.map(line => ({ item: Number(line.item_id), quantity: Number(line.quantity) }));
      }, { order: detail, view: mode });
      if (mode === "packed") {assert.equal(result.length, 5); assert.ok(result.every(line => line.item !== 1356 && line.item !== 1784));}
      else {assert.deepEqual(result, [{ item: 1784, quantity: 6 }]);}
      await page.screenshot({ path: `${folder}/operator-${mode}.png` });
      results.push({ mode, cardVisible: true, lines: result });
    }
    await writeFile(`${folder}/browser.json`, JSON.stringify(results, null, 2));
    console.log(JSON.stringify(results));
  }, { rollback: true });
} finally {await browser?.close(); await closeDb();}
