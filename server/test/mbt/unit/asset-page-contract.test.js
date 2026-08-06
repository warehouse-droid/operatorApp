import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function optionalSource(url) {
  return readFile(url, "utf8").catch((error) => {
    if (error?.code === "ENOENT") {
      return "";
    }
    throw error;
  });
}

const [serverSource, sidebarSource, shellSource, assetClientSource, assetHtml] = await Promise.all([
  readFile(new URL("../../../src/server.js", import.meta.url), "utf8"),
  readFile(new URL("../../../public/app-sidebar.js", import.meta.url), "utf8"),
  readFile(new URL("../../../public/mbt-shell.js", import.meta.url), "utf8"),
  optionalSource(new URL("../../../public/mbt-assets.js", import.meta.url)),
  optionalSource(new URL("../../../public/mbt-assets.html", import.meta.url))
]);
const browserSource = `${shellSource}\n${assetClientSource}`;

test("P3-F11 browser contract: the isolated asset page is routed and visible only through the MBT sidebar", () => {
  assert.ok(
    /app\.get\(["']\/mbt\/assets["'][\s\S]{0,300}mbt-assets\.html/.test(serverSource),
    "P3.5 requires a dedicated /mbt/assets route and mbt-assets.html surface."
  );
  assert.match(sidebarSource, /href:\s*["']\/mbt\/assets["']/);
  assert.match(sidebarSource, /\/mbt\/assets[\s\S]{0,300}(admin|dispatcher)/i);
  assert.match(assetHtml, /<body[^>]+data-mbt-surface=["']assets["']/i);
  assert.match(assetHtml, /<main[^>]+id=["']mbtApp["'][^>]+aria-labelledby=/i);
  assert.match(assetHtml, /<h1[^>]*>[^<]*(asset|bin)/i);
  assert.match(assetHtml, /aria-live=["']polite["']/i);
});

test("P3-F11/P3-F23 browser contract: registry, timeline, CSV opening inventory, and reconciliation remain one local-only surface", () => {
  assert.ok(assetHtml, "P3.5 requires the isolated mbt-assets.html browser surface.");
  assert.match(assetHtml, /asset registry/i);
  assert.match(assetHtml, /current state/i);
  assert.match(assetHtml, /timeline/i);
  assert.match(assetHtml, /(CSV|opening inventory)/i);
  assert.match(assetHtml, /reconciliation/i);
  assert.match(browserSource, /assets\s*:\s*\{[\s\S]{0,240}\/api\/mbt\/assets/);
  assert.match(browserSource, /new URLSearchParams|encodeURIComponent/);
  assert.match(browserSource, /cache:\s*["']no-store["']/);
  assert.doesNotMatch(browserSource, /\/api\/(scm|dispatch|driver|operator)\//);
});
