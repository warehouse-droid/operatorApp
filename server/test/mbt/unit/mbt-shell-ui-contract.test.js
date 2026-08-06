import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const [
  shellCss, shellClient, homeHtml, assetsHtml, assetsClient, configHtml,
  frontdeskHtml, billingHtml, gatesHtml
] = await Promise.all([
  readFile(new URL("../../../public/mbt-shell.css", import.meta.url), "utf8"),
  readFile(new URL("../../../public/mbt-shell.js", import.meta.url), "utf8"),
  readFile(new URL("../../../public/mbt-home.html", import.meta.url), "utf8"),
  readFile(new URL("../../../public/mbt-assets.html", import.meta.url), "utf8"),
  readFile(new URL("../../../public/mbt-assets.js", import.meta.url), "utf8"),
  readFile(new URL("../../../public/mbt-config.html", import.meta.url), "utf8"),
  readFile(new URL("../../../public/mbt-frontdesk.html", import.meta.url), "utf8"),
  readFile(new URL("../../../public/mbt-billing.html", import.meta.url), "utf8"),
  readFile(new URL("../../../public/mbt-gates.html", import.meta.url), "utf8")
]);

test("MBT shell: every MBT surface uses the shared Dispatch-style application layout", () => {
  for (const html of [homeHtml, assetsHtml, configHtml, frontdeskHtml, billingHtml, gatesHtml]) {
    assert.match(html, /class=["'][^"']*dispatch-shell[^"']*["']/i);
    assert.match(html, /class=["'][^"']*mbt-app-topbar[^"']*["']/i);
  }
  assert.match(shellCss, /body\.has-app-sidebar\s+\.mbt-shell/i);
  assert.match(shellCss, /\.mbt-app-topbar/i);
  assert.match(shellCss, /--app-sidebar-width/i);
  assert.match(gatesHtml, /<h1[^>]+id=["']mbtTitle["'][^>]*>Feature gates<\/h1>/i);
});

test("MBT assets: manual registration selects an active Bin item and current address", () => {
  assert.match(assetsHtml, /<select[^>]+id=["']assetItemCode["'][^>]*required/i);
  assert.match(assetsHtml, /<select[^>]+id=["']assetCurrentLocationId["']/i);
  assert.match(assetsHtml, /<input[^>]+id=["']assetCurrentAddress["']/i);
  assert.doesNotMatch(assetsHtml, /id=["']assetHomeYardId["']/i);
  assert.match(assetsClient, /\/api\/mbt\/assets\/opening-options/);
  assert.match(assetsClient, /binItems/);
  assert.match(assetsClient, /currentLocations/);
  assert.match(assetsClient, /labelFor:\s*\(item\)\s*=>[^;]+displayName/i);
  assert.match(assetsClient, /item\.address/i);
});

test("MBT config: every protected CSV template uses an authenticated Blob download", () => {
  for (const href of [
    "/api/mbt/config/imports/local-items/template",
    "/api/mbt/config/imports/dump-sites/template"
  ]) {
    assert.match(configHtml, new RegExp(`data-mbt-template-download[^>]+${href}`, "i"));
  }
  assert.doesNotMatch(configHtml, /\/api\/mbt\/config\/imports\/materials\/template/i);
  assert.match(shellClient, /function downloadProtectedTemplate/);
  assert.match(shellClient, /authorization:\s*`Bearer \$\{token\}`/);
  assert.match(shellClient, /URL\.createObjectURL\(await response\.blob\(\)\)/);
  assert.match(shellClient, /\[data-mbt-template-download\]/);
});
