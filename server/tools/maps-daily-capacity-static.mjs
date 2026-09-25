import assert from "node:assert/strict";
import { ESLint } from "eslint";
import { readFile, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";

const files = ["src/google-maps-usage-policy.js", "src/google-maps-usage-repository.js", "src/server.js", "public/control.js"];
for (const file of files) {
  const checked = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
  assert.equal(checked.status, 0, checked.stderr);
}
const globals = Object.fromEntries(["console", "process", "Buffer", "setTimeout", "URL", "fetch", "crypto",
  "document", "window", "mapsUsage", "operator", "hasStaffAuthority", "escapeHtml", "render", "request",
  "mapsDailyReopenBusy", "mapsDailyReopenRequest"].map((name) => [name, "writable"]));
const eslint = new ESLint({ overrideConfigFile: true, overrideConfig: [{
  languageOptions: { ecmaVersion: "latest", sourceType: "module", globals },
  rules: { "no-undef": "error", "no-unused-vars": ["error", { varsIgnorePattern: "^(renderMapsUsageSection|reopenMapsDailyCapacity)$" }],
    "no-unreachable": "error", "no-constant-condition": "error", "no-duplicate-imports": "error", "eqeqeq": ["error", "smart"] }
}] });
const results = await eslint.lintFiles(files.slice(0, 2));
const control = await readFile("public/control.js", "utf8");
const snippet = control.slice(control.indexOf("function mapsUsageActionLabel("), control.indexOf("function renderDashboardSection("));
results.push(...await eslint.lintText(snippet, { filePath: "public/maps-usage-panel.js" }));
const formatted = await (await eslint.loadFormatter("stylish")).format(results);
await writeFile("test-artifacts/maps-daily-capacity/lint.log", formatted);
assert.equal(results.reduce((sum, row) => sum + row.errorCount + row.warningCount, 0), 0, formatted);
console.log("Maps source syntax and focused ESLint passed.");
