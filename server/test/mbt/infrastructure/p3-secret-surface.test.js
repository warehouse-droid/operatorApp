import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const packageJson = JSON.parse(await readFile(
  new URL("../../../package.json", import.meta.url),
  "utf8"
));

const PHASE_3_PUBLIC_FILES = Object.freeze([
  "public/driver-bin-ui.js",
  "public/mbt-assets.html",
  "public/mbt-assets.js",
  "public/mbt-billing.html",
  "public/mbt-billing.js",
  "public/mbt-config.html",
  "public/mbt-frontdesk.css",
  "public/mbt-frontdesk.html",
  "public/mbt-frontdesk.js",
  "public/mbt-shell.css",
  "public/mbt-shell.js"
]);

test("P3 gauntlet: the explicit secret scan owns every Phase 3 migration and browser entry point", () => {
  const command = String(packageJson.scripts?.["secrets:mbt"] || "");
  for (let sequence = 110; sequence <= 122; sequence += 1) {
    assert.match(
      command,
      new RegExp(`(?:^|\\s)migrations/${sequence}_[^\\s]+\\.sql(?:\\s|$)`, "u"),
      `Migration ${sequence} must be inside the explicit secret-scan surface.`
    );
  }
  for (const file of PHASE_3_PUBLIC_FILES) {
    assert.match(
      command,
      new RegExp(`(?:^|\\s)${file.replaceAll(".", "\\.")}(?:\\s|$)`, "u"),
      `${file} must be inside the explicit secret-scan surface.`
    );
  }
});
