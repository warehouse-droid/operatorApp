import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER_ROOT = path.resolve(HERE, "../../..");
const read = (relativePath) => fs.readFileSync(path.join(SERVER_ROOT, relativePath), "utf8");

const SERVER_SOURCE = read("src/server.js");
const DRIVER_SOURCE = read("public/driver.js");
const DRIVER_HTML = read("public/driver.html");
const RESET_HTML = read("public/driver-reset.html");
const WORKER_SOURCE = read("public/driver-service-worker.js");

test("the emergency reset URL is outside the Driver service-worker scope and is exposed only by the version-update screen", () => {
  assert.match(SERVER_SOURCE, /app\.get\("\/reset-driver"/u);
  assert.doesNotMatch("/reset-driver", /^\/driver(?:\/|$)/u);
  const updateScreenStart = DRIVER_SOURCE.indexOf("function renderDriverPwaUpdateRequired() {");
  const updateScreenEnd = DRIVER_SOURCE.indexOf("function requireDriverPwaUpdate(", updateScreenStart);
  assert.notEqual(updateScreenStart, -1, "The version-update renderer must exist.");
  assert.notEqual(updateScreenEnd, -1, "The version-update renderer must have a stable boundary.");
  assert.match(
    DRIVER_SOURCE.slice(updateScreenStart, updateScreenEnd),
    /href="\/reset-driver"/u,
    "The version-update-required screen must expose the hard reset."
  );
  assert.equal(
    DRIVER_SOURCE.match(/href="\/reset-driver"/gu)?.length,
    1,
    "No login, status, normal-work, or ordinary recovery screen may expose the destructive reset."
  );
  assert.match(DRIVER_SOURCE, /Emergency online recovery only/u);
  assert.match(DRIVER_SOURCE, /permanently deletes all MBBS site storage/u);
});

test("the reset endpoint is explicit, same-origin protected, no-store, and uses Clear-Site-Data", () => {
  assert.match(SERVER_SOURCE, /app\.post\("\/api\/driver\/site-reset"/u);
  assert.match(SERVER_SOURCE, /x-mbbs-driver-site-reset["']\) !== "confirm"/u);
  assert.match(SERVER_SOURCE, /sec-fetch-site/u);
  assert.match(SERVER_SOURCE, /DRIVER_SITE_RESET_CROSS_SITE_BLOCKED/u);
  assert.ok(
    SERVER_SOURCE.includes(`res.setHeader("Clear-Site-Data", '"cache", "cookies", "storage"')`),
    "The reset response must request cache, cookie, and storage deletion."
  );
  assert.match(SERVER_SOURCE, /no-store, no-cache, must-revalidate, private/u);
  assert.match(SERVER_SOURCE, /getDriverSession\(token, \{ touch: false \}\)/u);
  assert.match(SERVER_SOURCE, /revokeDriverSession\(token\)/u);
  assert.match(SERVER_SOURCE, /revokeDriverOfflineGrants/u);
});

test("the standalone WebKit fallback clears every origin storage layer but accurately excludes browser history", () => {
  assert.match(RESET_HTML, /unsynchronized actions, photos, login sessions, IndexedDB, service workers/u);
  assert.match(RESET_HTML, /cannot erase Chrome's browsing-history list/u);
  assert.match(RESET_HTML, /id="resetDriverSite" type="button" disabled/u);
  assert.ok(
    RESET_HTML.includes(
      'confirmation.addEventListener("change", () => {\n          resetButton.disabled = !confirmation.checked;\n        });'
    ),
    "Checking the explicit confirmation must be the only action that enables reset."
  );
  assert.match(RESET_HTML, /navigator\.serviceWorker\.getRegistrations\(\)/u);
  assert.match(RESET_HTML, /registration\.unregister\(\)/u);
  assert.match(RESET_HTML, /caches\.keys\(\)/u);
  assert.match(RESET_HTML, /caches\.delete\(name\)/u);
  assert.match(RESET_HTML, /globalThis\.indexedDB\.databases\(\)/u);
  assert.match(RESET_HTML, /indexedDB\.deleteDatabase\(name\)/u);
  assert.match(RESET_HTML, /"mbbs-driver-offline"/u);
  assert.match(RESET_HTML, /localStorage\.clear\(\)/u);
  assert.match(RESET_HTML, /sessionStorage\.clear\(\)/u);
  assert.match(RESET_HTML, /Max-Age=0/u);
  assert.match(RESET_HTML, /history\.replaceState/u);
  assert.match(RESET_HTML, /window\.location\.replace\(redirect\)/u);
  assert.doesNotMatch(RESET_HTML, /chrome\.browsingData/u);
});

test("the reset ships as a new atomic shell generation without forcing a protocol-version cutover", () => {
  assert.match(DRIVER_HTML, /driver\.js\?v=20260819-driver-route-readiness-v1/u);
  assert.match(DRIVER_SOURCE, /driver-service-worker\.js\?v=20260819-driver-route-readiness-v1/u);
  assert.match(WORKER_SOURCE, /DRIVER_CACHE_NAME = `\$\{DRIVER_CACHE_PREFIX\}v38`/u);
  assert.match(WORKER_SOURCE, /driver\.js\?v=20260819-driver-route-readiness-v1/u);
  assert.match(DRIVER_SOURCE, /DRIVER_PWA_CLIENT_VERSION = "2026\.08\.12\.3"/u);
  assert.match(WORKER_SOURCE, /DRIVER_PWA_CLIENT_VERSION = "2026\.08\.12\.3"/u);
});
