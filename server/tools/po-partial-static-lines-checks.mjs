import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { ESLint } from "eslint";
import { mutants } from "../test/support/po-partial-static-lines-mutations.mjs";
import { scanUnifiedDiff, scanPaths } from "../test/support/scan-diff-secrets.mjs";

export const focused = ["test/mbt/integration/po-partial-static-lines.test.js"];
export const adjacent = ["test/mbt/integration/operator-direct-orderline.test.js",
  "test/mbt/integration/receiving-split-balance.test.js", "test/mbt/integration/operator-receiving-allocations.test.js",
  "test/mbt/integration/operator-receiving-identity.test.js", "test/mbt/integration/sn1400625-receiving.test.js",
  "test/mbt/unit/operator-netsuite-posting-targets.red.test.js", "test/mbt/unit/operator-netsuite-posting-domain.red.test.js",
  "test/mbt/unit/operator-netsuite-posting-service.red.test.js", "test/mbt/unit/operator-direct-orderline-service.test.js",
  "test/mbt/integration/operator-posting-http-timing.test.js"];
const sources = ["src/operator-po-receipt-availability.js", "src/operator-netsuite-posting-targets.js"];
const additions = [sources[0], ...focused, "test/support/po-partial-static-lines-mutations.mjs", "tools/po-partial-static-lines-checks.mjs"];
const root = "test-artifacts/po-partial-static-lines", before = "/workspace/server/test-artifacts/po-partial-static-lines/before";
fs.mkdirSync(root, { recursive: true });
const run = (args, options = {}) => spawnSync(process.execPath, args, { encoding: "utf8", maxBuffer: 32 * 1024 * 1024, timeout: 240000, ...options });
function checked(args) {
  const result = run(args, { stdio: "inherit" });
  assert.equal(result.status, 0, args.join(" "));
}
function save(name, value) {
  fs.writeFileSync(`${root}/${name}.json`, JSON.stringify(value, null, 2) + "\n");
  console.log(JSON.stringify(value));
}
function diff(file) {
  return spawnSync("diff", ["-U0", fs.existsSync(`${before}/${file}`) ? `${before}/${file}` : "/dev/null", file], { encoding: "utf8" }).stdout;
}

if (process.argv[2] === "static") {
  for (const file of [...sources, ...additions.slice(1)]) checked(["--check", file]);
  const eslint = new ESLint({ overrideConfigFile: true, overrideConfig: [{
    files: ["**/*.{js,mjs}"], languageOptions: { ecmaVersion: "latest", sourceType: "module",
      globals: { process: "readonly", console: "readonly", Buffer: "readonly", structuredClone: "readonly", URL: "readonly", Response: "readonly", window: "readonly", localStorage: "readonly" } },
    rules: { "no-undef": "error", "no-unused-vars": "error", "no-unreachable": "error", "eqeqeq": "error" }
  }] });
  const messages = rows => rows.flatMap(row => row.messages.map(message => `${message.ruleId}: ${message.message}`)).sort();
  assert.deepEqual(messages(await eslint.lintFiles(additions)), [], "New lint findings");
  for (const file of sources.slice(1)) {
    const baseline = messages(await eslint.lintText(fs.readFileSync(`${before}/${file}`, "utf8"), { filePath: file }));
    assert.deepEqual(messages(await eslint.lintFiles(file)), baseline, `${file}: new lint findings`);
  }
  const baselineRoot = fs.mkdtempSync("/tmp/po-partial-types-");
  fs.cpSync("src", `${baselineRoot}/src`, { recursive: true });
  fs.cpSync("public", `${baselineRoot}/public`, { recursive: true });
  fs.copyFileSync(`${before}/src/operator-netsuite-posting-targets.js`, `${baselineRoot}/src/operator-netsuite-posting-targets.js`);
  fs.copyFileSync("package.json", `${baselineRoot}/package.json`);
  fs.symlinkSync(path.resolve("node_modules"), `${baselineRoot}/node_modules`, "dir");
  const typeArgs = [path.resolve("node_modules/typescript/bin/tsc"), "--allowJs", "--checkJs", "--noEmit", "--skipLibCheck", "--module", "nodenext", "--target", "ES2022"];
  const baselineTypes = run([...typeArgs, "src/operator-netsuite-posting-targets.js"], { cwd: baselineRoot });
  const types = run([...typeArgs, ...sources.slice(0, 2)]);
  const diagnostics = result => {
    assert.ok(!result.error);
    const output = result.stdout + result.stderr;
    const rows = output.split("\n").filter(line => /error TS\d+/.test(line)).map(line => line.replace(/\(\d+,\d+\)/, "(line,column)")).sort();
    assert.ok(rows.length || result.status === 0, output);
    return rows;
  };
  fs.writeFileSync(`${root}/types-before.log`, baselineTypes.stdout + baselineTypes.stderr);
  fs.writeFileSync(`${root}/types-after.log`, types.stdout + types.stderr);
  assert.deepEqual(diagnostics(types), diagnostics(baselineTypes), "New type diagnostics");
  assert.deepEqual(diagnostics(types).filter(row => row.startsWith("src/operator-po-receipt-availability.js")), []);
  for (const file of sources.slice(1)) assert.deepEqual(scanUnifiedDiff(diff(file)), []);
  assert.deepEqual(await scanPaths(additions), []);
  save("static", { newLintFindings: 0, newTypeDiagnostics: 0, existingTypeDiagnostics: diagnostics(types).length, secretFindings: 0 });
} else if (process.argv[2] === "suite") {
  checked(["--test", "--test-concurrency=1", ...focused, ...adjacent]);
} else if (process.argv[2] === "coverage") {
  const coverage = JSON.parse(fs.readFileSync(`${root}/coverage/coverage-final.json`, "utf8"));
  const result = {};
  for (const file of sources) {
    const lines = [];
    for (const match of diff(file).matchAll(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gm)) {
      for (let index = 0; index < Number(match[2] ?? 1); index++) lines.push(Number(match[1]) + index);
    }
    const row = Object.values(coverage).find(entry => entry.path.endsWith(`/${file}`));
    assert.ok(row, `Missing coverage: ${file}`);
    const executable = lines.filter(line => Object.values(row.statementMap).some(loc => loc.start.line <= line && loc.end.line >= line));
    const missing = executable.filter(line => !Object.entries(row.statementMap).some(([id, loc]) => loc.start.line <= line && loc.end.line >= line && row.s[id] > 0));
    assert.deepEqual(missing, [], `Uncovered changed lines: ${file}`);
    const branches = Object.entries(row.branchMap).filter(([, value]) => lines.includes(value.loc.start.line)).flatMap(([id]) => row.b[id]);
    result[file] = { changedExecutableLines: executable.length, covered: executable.length, branches: branches.length, coveredBranches: branches.filter(count => count > 0).length };
  }
  save("coverage", result);
} else if (process.argv[2] === "mutations") {
  const results = [];
  for (const name of Object.keys(mutants)) {
    for (const propertiesOnly of [false, true]) {
      const args = ["--loader", "./test/support/po-partial-static-lines-mutations.mjs", "--test"];
      if (propertiesOnly) args.push("--test-name-pattern=^property:");
      args.push(focused[0]);
      const result = run(args, { env: { ...process.env, PO_PARTIAL_MUTATION: name } });
      const output = result.stdout + result.stderr;
      fs.writeFileSync(`${root}/mutant-${name}-${propertiesOnly ? "property" : "all"}.log`, output);
      assert.ok(result.status !== 0 && /ERR_ASSERTION|Property failed/.test(output) && output.includes(`PO_PARTIAL_MUTATION_APPLIED:${name}`), `Surviving mutant: ${name}, properties=${propertiesOnly}`);
      assert.doesNotMatch(output, /Invalid mutation anchor|SyntaxError|ERR_MODULE_NOT_FOUND/);
      results.push({ name, propertiesOnly, killed: true });
    }
  }
  save("mutations", results);
} else if (process.argv[2] === "shuffle") {
  const hash = value => createHash("sha256").update("20260922:" + value).digest("hex");
  for (const file of [...focused, ...adjacent].sort((a, b) => hash(a).localeCompare(hash(b)))) {
    console.log("Suite health seed 20260922: " + file);
    checked(["--test", file]);
  }
} else throw new Error("Choose static, suite, coverage, mutations or shuffle");
