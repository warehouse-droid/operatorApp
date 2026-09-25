import assert from "node:assert/strict";
import fs from "node:fs";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { ESLint } from "eslint";
import { scanPaths } from "../test/support/scan-diff-secrets.mjs";
import { mutants } from "../test/support/operator-background-photo-mutations.mjs";

const artifact = "test-artifacts/operator-background-photos";
export const sources = ["src/operator-background-photos.js", "src/operator-background-photo-worker.js", "src/server.js",
  "src/delivery-repository.js", "src/receiving-repository.js", "src/sales-order-reload-repository.js",
  "src/consolidation-load-service.js", "src/operator-yard-authorization.js", "src/photo-archive-repository.js",
  "public/operator-photo-outbox.js", "public/operator.js", "public/service-worker.js", "public/control.js", "public/sales.js", "public/dispatch-loaded-export.js"];
const tests = ["test/mbt/unit/operator-background-confirm.test.js", "test/mbt/integration/operator-background-photos.test.js",
  "test/mbt/integration/operator-background-http.test.js", "test/mbt/property/operator-background-photos.test.js"];
function run(args, name) {
  const result = spawnSync(process.execPath, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: 300000 });
  const output = (result.stdout || "") + (result.stderr || "");
  fs.writeFileSync(`${artifact}/${name}.log`, output);
  assert.ok(!result.error, String(result.error));
  return { status: result.status, output };
}
function save(name, value) { fs.writeFileSync(`${artifact}/${name}.json`, JSON.stringify(value, null, 2)); console.log(JSON.stringify({ name, ...value })); }
const mode = process.argv[2];
if (mode === "baseline-static" || mode === "static") {
  const available = sources.filter(file => fs.existsSync(file));
  for (const file of available) assert.equal(run(["--check", file], `syntax-${file.replaceAll("/", "-")}`).status, 0);
  const globals = Object.fromEntries(["window", "document", "navigator", "self", "caches", "fetch", "localStorage", "sessionStorage", "setTimeout", "clearTimeout", "setInterval", "clearInterval", "AbortController", "AbortSignal", "URL", "URLSearchParams", "Blob", "File", "FileReader", "FormData", "Request", "Image", "ImageCapture", "EventSource", "HTMLElement", "Element", "HTMLInputElement", "HTMLImageElement", "ResizeObserver", "IntersectionObserver", "MutationObserver", "CustomEvent", "Event", "performance", "location", "atob", "btoa", "crypto", "process", "console", "Buffer", "structuredClone"].map(name => [name, "readonly"]));
  const eslint = new ESLint({ overrideConfigFile: true, overrideConfig: [{ files: ["**/*.{js,mjs}"], languageOptions: { ecmaVersion: "latest", sourceType: "module", globals },
    rules: { "no-undef": "error", "no-unused-vars": "error", "no-unreachable": "error", "eqeqeq": "error" } }] });
  const lint = (await eslint.lintFiles(available)).flatMap(row => row.messages.map(message => `${row.filePath.replace(/^.*\/app\//, "")}: ${message.ruleId} ${message.message}`)).sort();
  const typed = run(["node_modules/typescript/bin/tsc", "--allowJs", "--checkJs", "--noEmit", "--skipLibCheck", "--module", "nodenext", "--target", "ES2022", ...available], `${mode}-types`);
  const diagnostics = typed.output.split("\n").filter(line => /error TS\d+/.test(line)).map(line => line.replace(/\(\d+,\d+\)/, "(line,column)")).sort();
  assert.ok(diagnostics.length || typed.status === 0, "Type checker did not execute");
  assert.deepEqual(await scanPaths(available), []);
  const value = { lint, diagnostics };
  fs.writeFileSync(`${artifact}/${mode}.json`, JSON.stringify(value, null, 2));
  if (mode === "static") {
    const baseline = JSON.parse(fs.readFileSync(`${artifact}/baseline-static.json`));
    const additions = (now, before) => { const bag = new Map(); before.forEach(value => bag.set(value, (bag.get(value) || 0) + 1)); return now.filter(value => { if (!bag.get(value)) return true; bag.set(value, bag.get(value) - 1); return false; }); };
    const newLint = additions(lint, baseline.lint), newTypes = additions(diagnostics, baseline.diagnostics);
    save("static-diff", { lintCount: lint.length, typeCount: diagnostics.length, newLint, newTypes });
    assert.deepEqual(newLint, []); assert.deepEqual(newTypes, []);
  } else console.log(JSON.stringify({ mode, lint: lint.length, types: diagnostics.length }));
} else if (mode === "suite-forward" || mode === "suite-reverse") {
  const adjacent = JSON.parse(fs.readFileSync("test/support/operator-background-suites.json"));
  const baselineOutput = fs.readFileSync(`${artifact}/baseline-suite.log`, "utf8");
  const failed = output => [...output.matchAll(/^not ok \d+ - (.+)$/gm)].map(match => match[1]).sort();
  const results = [];
  for (const reverse of [mode === "suite-reverse"]) {
    const selected = [...adjacent, ...tests]; if (reverse) selected.reverse();
    const result = run(["--test", "--test-concurrency=1", ...selected], `suite-${reverse ? "reverse" : "forward"}`);
    assert.deepEqual(failed(result.output), failed(baselineOutput), "New affected-suite failures");
    results.push({ reverse, counts: result.output.split("\n").filter(line => /^# (tests|pass|fail|skipped) /.test(line)), baselineFailures: failed(result.output) });
  }
  save(mode, { results, sourceHashes: Object.fromEntries(sources.map(file => [file, crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex")])) });
} else if (mode === "mutations") {
  const results = [];
  for (const mutant of mutants) {
    process.env.BACKGROUND_PHOTO_MUTANT = mutant.name;
    const args = ["--loader", "./test/support/operator-background-photo-mutations.mjs", "--test", "--test-concurrency=1"];
    const result = run([...args, "test/mbt/integration/operator-background-photos.test.js", "test/mbt/property/operator-background-photos.test.js"], `mutant-${mutant.name}`);
    assert.notEqual(result.status, 0, `Surviving mutant: ${mutant.name}`);
    assert.match(result.output, /^not ok /m, "Mutant failed before executing an assertion");
    const property = run([...args, "test/mbt/property/operator-background-photos.test.js"], `property-mutant-${mutant.name}`);
    results.push({ name: mutant.name, killed: true, propertyKilled: property.status !== 0 });
  }
  delete process.env.BACKGROUND_PHOTO_MUTANT;
  save("mutations", { results });
} else if (mode === "coverage") {
  const result = run(["node_modules/c8/bin/c8.js", "--all=false", "--include=src/operator-background-photos.js", "--reporter=json-summary", "--reporter=json", "--reporter=text", `--temp-directory=${artifact}/c8`, `--reports-dir=${artifact}/coverage`, "node", "--test", "--test-concurrency=1", ...tests], "coverage");
  assert.equal(result.status, 0, "Coverage suite failed");
  console.log(fs.readFileSync(`${artifact}/coverage/coverage-summary.json`, "utf8"));
}
