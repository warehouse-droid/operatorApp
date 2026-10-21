import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { Linter } from "eslint";

const files = ["public/dispatch.js", "public/mbt-planning.js"];
const baseline = "/workspace/server/test-artifacts/bin-planner-readonly-release-20260927/baseline/";
const globals = Object.fromEntries(["window", "document", "location", "navigator", "sessionStorage", "localStorage", "fetch", "FormData", "Headers", "Request", "Response", "URL", "URLSearchParams", "AbortController", "AbortSignal", "Blob", "FileReader", "File", "Image", "Event", "CustomEvent", "EventSource", "HTMLElement", "Element", "HTMLInputElement", "ResizeObserver", "MutationObserver", "DOMParser", "crypto", "performance", "structuredClone", "alert", "confirm", "prompt", "console", "setTimeout", "clearTimeout", "setInterval", "clearInterval", "google"].map(name => [name, "readonly"]));
const rules = Object.fromEntries(["no-undef", "no-unreachable", "no-dupe-args", "no-dupe-keys", "no-duplicate-case", "valid-typeof", "no-func-assign", "no-import-assign", "no-unsafe-finally"].map(name => [name, "error"]));
function diagnostics(file, prefix) {
  const host = readFileSync(prefix + "public/dispatch.js", "utf8") + readFileSync(prefix + "public/dispatch-auth.js", "utf8");
  const shared = Object.fromEntries([...host.matchAll(/^(?:async\s+)?(?:function|let|const)\s+([\w$]+)/gm)].map(match => [match[1], "writable"]));
  return new Linter().verify(readFileSync(prefix + file, "utf8"), { languageOptions: { ecmaVersion: "latest", sourceType: "script", globals: { ...globals, ...shared } }, rules });
}
const report = [];
for (const file of files) {
  const syntax = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
  assert.equal(syntax.status, 0, syntax.stderr);
  const prior = diagnostics(file, baseline);
  const current = diagnostics(file, "");
  const counts = list => list.reduce((map, row) => { const key = `${row.ruleId}: ${row.message}`; map[key] = (map[key] || 0) + 1; return map; }, {});
  const oldCounts = counts(prior);
  const added = Object.entries(counts(current)).filter(([key, count]) => count > (oldCounts[key] || 0));
  assert.deepEqual(added, [], `${file}: new lint errors`);
  report.push({ file, syntax: "passed", priorDiagnostics: prior.length, currentDiagnostics: current.length, newDiagnostics: added });
}
writeFileSync("test-artifacts/readonly-static.json", JSON.stringify(report, null, 2));
console.log(JSON.stringify(report));
