import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { ESLint } from "eslint";
import base from "../eslint.mbt.config.js";
import { production, unit, database, browser } from "./operator-display-files.mjs";

const label = process.argv[2] || "current";
const root = process.cwd();
const folder = `${root}/test-artifacts/operator-display-fix`;
mkdirSync(folder, { recursive: true });
if (label === "baseline") { process.chdir(`${folder}/baseline`); }
const additional = ["tools/operator-display-files.mjs", "tools/operator-display-static.mjs", "tools/operator-display-checks.mjs",
  "test/support/operator-display-refresh-fixture.mjs", "test/support/operator-display-mutation-loader.mjs", "test/mbt/unit/operator-delivery-refresh.test.js", browser];
const targets = [...new Set([...production.filter((file) => file.endsWith(".js")), ...unit, ...database, ...additional])].filter(existsSync);
for (const file of targets) {
  const syntax = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
  assert.equal(syntax.status, 0, syntax.stdout + syntax.stderr);
}
const browserGlobals = Object.fromEntries(["window", "document", "localStorage", "selectedOrder", "selectedId", "selectedLineId", "deliveryOrdersLoadingCount",
  "deliveryOrderBuckets", "viewMode", "orders", "locationId", "loadOrders", "loadDetail", "primePackedDeliveryOrders", "markLocalDeliveryMutation",
  "acceptRefreshedDeliveryOrder", "finishLocalDeliveryMutation", "orderPage", "renderDeliveryPanels", "deliveryPrepMode", "deliveryLoadViewDate",
  "deliveryLoadViewTruck", "currentModule", "render", "activateCachedDeliveryView", "invalidateDeliveryOrders", "loadCurrentDeliveryDraft",
  "loadDeliveryNotifications", "activeDeliveryDraft", "deliveryNotifications", "removeDeliveryOrderFromLocalState", "packedDeliveryPrefetch"].map((key) => [key, "writable"]));
const eslint = new ESLint({ overrideConfigFile: true, overrideConfig: [...base,
  { ...base[0], files: ["public/operator-delivery-refresh.js"] },
  { files: [browser], languageOptions: { globals: browserGlobals } }
] });
// The two legacy monoliths have no repository ESLint configuration; syntax is checked above.
const lintTargets = targets.filter((file) => !["public/operator.js", "public/service-worker.js", "src/delivery-repository.js"].includes(file));
const lint = (await eslint.lintFiles(lintTargets)).flatMap((file) => file.messages.map((message) => ({ file: file.filePath.replace("/app/", ""), ...message })));
const types = spawnSync(`${root}/node_modules/.bin/tsc`, ["--project", "tsconfig.mbt.json", "--pretty", "false"], { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
const diagnostics = (types.stdout + types.stderr).split("\n").filter((line) => /error TS\d+/u.test(line));
const trackerTypes = existsSync("public/operator-delivery-refresh.js")
  ? spawnSync(`${root}/node_modules/.bin/tsc`, ["--allowJs", "--checkJs", "--noEmit", "--skipLibCheck", "--target", "ES2023", "--strict", "public/operator-delivery-refresh.js", "--pretty", "false"], { encoding: "utf8" }) : null;
const report = { lint, diagnostics, trackerTypes: trackerTypes ? { status: trackerTypes.status, output: trackerTypes.stdout + trackerTypes.stderr } : null };
writeFileSync(`${folder}/static-${label}.json`, JSON.stringify(report, null, 2));
console.log(JSON.stringify({ label, lint: lint.length, types: diagnostics.length, trackerTypes: report.trackerTypes }));
if (label === "current") {
  const prior = JSON.parse(readFileSync("test/support/operator-display-static-baseline.json", "utf8"));
  const normalize = (line) => line.replace(/\(\d+,\d+\)/gu, "");
  const known = new Set(prior.diagnostics.map(normalize));
  assert.deepEqual(diagnostics.filter((line) => !known.has(normalize(line))), [], "New TypeScript diagnostics");
  assert.deepEqual(lint, [], "Lint diagnostics");
  assert.equal(trackerTypes?.status, 0, trackerTypes?.stdout + trackerTypes?.stderr);
}
