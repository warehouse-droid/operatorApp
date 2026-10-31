import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import http from "node:http";
import test from "node:test";
import { chromium } from "@playwright/test";

/* global normalizeOrder, groupAddressWarning */

// A group is one drop at the first selected order's address. Grouping orders
// bound for different addresses must be a visible choice, not a silent loss.
async function addressCase(run) {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    if (url.pathname.endsWith(".js")) {
      res.setHeader("Content-Type", "text/javascript");
      res.end(await readFile(new URL(`../../../public${url.pathname}`, import.meta.url))); return;
    }
    if (!url.pathname.startsWith("/api/")) {
      res.setHeader("Content-Type", "text/html");
      res.end('<!doctype html><main id="dispatchApp"></main><script>function requireDispatchLogin() {}</script><script src="/dispatch-edit-activity.js"></script><script src="/dispatch.js"></script>'); return;
    }
    res.setHeader("Content-Type", "application/json");
    res.end("{}");
  });
  let browser;
  try {
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
    const page = await browser.newPage();
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await run(page);
    assert.deepEqual(errors, []);
  } finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); }
}

const warn = (page, addresses) => page.evaluate(addresses => groupAddressWarning(addresses.map((address, index) =>
  normalizeOrder({ id: `SOADDR${index + 1}`, type: "SO", address, items: [] }))), addresses);

test("grouping orders for different addresses names the address the group will use", () => addressCase(async page => {
  const message = await warn(page, ["100 Main Street, Toronto, ON", "55 Other Road, Markham, ON"]);
  assert.match(message, /SOADDR1[\s\S]*100 Main Street[\s\S]*SOADDR2[\s\S]*55 Other Road/u);
  assert.match(message, /deliver only to 100 Main Street, Toronto, ON/u);
}));

test("formatting differences of one address need no confirmation", () => addressCase(async page => {
  assert.equal(await warn(page, ["100 Main Street, Toronto, ON", "100 main st. toronto ON"]), "");
}));

test("the Group action asks before building a group across addresses", async () => {
  const source = await readFile(new URL("../../../public/dispatch.js", import.meta.url), "utf8");
  const handler = source.slice(source.indexOf('if (action === "confirm-group")'));
  const warning = handler.indexOf("groupAddressWarning(");
  assert.ok(warning > 0 && warning < handler.indexOf("groupOrder(button.dataset.order)"));
});
