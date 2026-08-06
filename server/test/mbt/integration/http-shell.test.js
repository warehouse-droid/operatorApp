import assert from "node:assert/strict";
import test, { after, before } from "node:test";

import { closeDb } from "../../../src/db.js";
import { app } from "../../../src/server.js";

let baseUrl;
let server;

before(async () => {
  server = app.listen(0, "127.0.0.1");
  await new Promise((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server) {
    await new Promise((resolve) => server.close(resolve));
  }
  await closeDb();
});

test("F15: all MBT routes render one accessible controlled shell with an explicit controller", async () => {
  for (const [path, surface, controllers, heading] of [
    ["/mbt", "home", ["mbt-home.js"], "MBT Bin Operations"],
    ["/admin/mbt-gates", "gates", ["mbt-gates.js"], "Feature gates"],
    ["/mbt/config", "config", ["mbt-shell.js"], "Configuration"],
    ["/mbt/assets", "assets", ["mbt-assets.js"], "Bin asset registry"],
    ["/mbt/frontdesk", "frontdesk", ["mbt-frontdesk.js"], "Front Desk"],
    ["/mbt/billing", "billing", ["mbt-shell.js", "mbt-billing.js"], "Reconcile, calculate, approve locally"]
  ]) {
    const response = await fetch(`${baseUrl}${path}`);
    const html = await response.text();
    assert.equal(response.status, 200, `${path}: ${html.slice(0, 120)}`);
    assert.match(response.headers.get("cache-control") || "", /no-(?:cache|store)/i);
    assert.match(response.headers.get("content-type") || "", /^text\/html/i);
    assert.match(html, /<html[^>]+lang="en"/i);
    assert.match(html, new RegExp(`data-mbt-surface=["']${surface}["']`, "i"));
    assert.match(html, /<main[^>]+id="mbtApp"/i);
    assert.match(html, /aria-live="polite"/i);
    assert.match(html, new RegExp(`<h1[^>]*>${heading}<\\/h1>`, "i"));
    assert.match(html, /href=["']\/mbt-shell\.css["']/i);
    assert.match(html, /src=["']\/app-sidebar\.js["']/i);
    for (const controller of controllers) {
      assert.match(html, new RegExp(`src=["']/${controller.replace(".", "\\.")}["']`, "i"));
    }
  }
});

test("F15: the shell assets are cache-revalidated and contain no operational write controls", async () => {
  const [scriptResponse, styleResponse] = await Promise.all([
    fetch(`${baseUrl}/mbt-shell.js`),
    fetch(`${baseUrl}/mbt-shell.css`)
  ]);
  const [script, style] = await Promise.all([scriptResponse.text(), styleResponse.text()]);
  assert.equal(scriptResponse.status, 200);
  assert.equal(styleResponse.status, 200);
  assert.match(script, /\/api\/auth\/me/);
  assert.match(script, /\/api\/mbt\/status/);
  assert.match(script, /textContent/);
  assert.doesNotMatch(script, /createSalesOrder|createDeposit|reserveBin|confirmDispatch/i);
  assert.match(style, /prefers-reduced-motion/);
});
