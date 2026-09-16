/* global document, renderOperatorNetSuitePostingMode */
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { chromium } from "@playwright/test";

const folder = "test-artifacts/operator-posting-latency";
mkdirSync(folder, { recursive: true });
const source = readFileSync("public/operator.js", "utf8");
const css = readFileSync("public/operator.css", "utf8");
const renderer = source.slice(source.indexOf("function renderOperatorNetSuitePostingMode("), source.indexOf("function operatorNetSuitePostingReady("));
const receivingClass = source.match(/return shell\(t\("operator.receiveOrder"[\s\S]*?<section class="([^"]+)"/)[1];
const browser = await chromium.launch({ args: ["--no-sandbox"] });
const results = [];
try {
  for (const [width, height] of [[390, 844], [768, 1024], [1280, 900]]) {
    const page = await browser.newPage({ viewport: { width, height } });
    await page.setContent(`<style>${css}</style><div style="height:104px"></div><section class="${receivingClass}" id="screen"></section>`);
    await page.addScriptTag({ content: `function escapeHtml(s) {return String(s).replaceAll("<", "&lt;");}\n${renderer}` });
    await page.evaluate(() => {
      document.getElementById("screen").innerHTML = renderOperatorNetSuitePostingMode({ effective: true, transactionType: "IR" })
        + '<div class="fulfillment-card"><strong>Truck photos</strong><div style="height:180px">Photo proof saved</div></div>'
        + '<div class="fulfillment-card"><strong>Receive quantities</strong><p>Two confirmed lines</p></div>'
        + '<div class="selected-actions"><button>Receive</button></div>';
    });
    const banner = await page.locator(".operator-posting-mode").boundingBox();
    const card = await page.locator(".fulfillment-card").first().boundingBox();
    results.push({ width, height, bannerHeight: banner.height, cardTop: card.y });
    await page.screenshot({ path: `${folder}/notice-${width}.png`, fullPage: true });
    assert.ok(banner.height <= 80, `Posting notice occupies ${banner.height}px at ${width}px`);
    assert.ok(card.y < 220, "The proof card must start close to the compact notice");
    await page.close();
  }
} finally {
  writeFileSync(`${folder}/browser.json`, `${JSON.stringify(results, null, 2)}\n`);
  await browser.close();
}
console.log(JSON.stringify(results));
