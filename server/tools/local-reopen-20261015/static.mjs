import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { ESLint } from "eslint";

const task = "tools/local-reopen-20261015";
const out = "test-artifacts/local-reopen-20261015";
const files = JSON.parse(readFileSync(task + "/files.json", "utf8")).filter(file => file.endsWith(".js"));
const root = mkdtempSync("/tmp/billed-reopen-types-");
const difference = (after, before) => {
  const remaining = [...before];
  return after.filter(value => { const index = remaining.indexOf(value); if (index < 0) { return true; } remaining.splice(index, 1); return false; });
};
try {
  for (const dir of ["src", "public"]) { cpSync(task + "/baseline/" + dir, root + "/" + dir, { recursive: true }); }
  symlinkSync(resolve("node_modules"), root + "/node_modules");
  cpSync("package.json", root + "/package.json");
  const types = cwd => spawnSync(process.execPath, [resolve("node_modules/typescript/bin/tsc"), "--noEmit", "--allowJs", "--checkJs",
    "--skipLibCheck", "--types", "node", "--target", "ES2022", "--module", "NodeNext", ...files.filter(file => existsSync(cwd + "/" + file))],
  { cwd, encoding: "utf8", timeout: 180_000, maxBuffer: 16 * 1024 * 1024 });
  const before = types(root), after = types(process.cwd());
  writeFileSync(`${out}/types-before.log`, JSON.stringify({ status: before.status, signal: before.signal, error: String(before.error) }) + "\n" + before.stdout + before.stderr);
  writeFileSync(`${out}/types-after.log`, JSON.stringify({ status: after.status, signal: after.signal, error: String(after.error) }) + "\n" + after.stdout + after.stderr);
  // The installed TypeScript 7 compiler returns 1 for type diagnostics.
  assert.ok([0, 1, 2].includes(before.status) && (before.status === 0 || /error TS\d+/u.test(before.stdout)), readFileSync(`${out}/types-before.log`, "utf8").slice(0, 1200));
  assert.ok([0, 1, 2].includes(after.status) && (after.status === 0 || /error TS\d+/u.test(after.stdout)), readFileSync(`${out}/types-after.log`, "utf8").slice(0, 1200));
  const typeMessages = log => log.split("\n").filter(line => /error TS\d+/u.test(line)).map(line => line.replace(/\(\d+,\d+\)/u, ""));
  const previous = typeMessages(before.stdout), current = typeMessages(after.stdout);
  const newTypes = difference(current, previous);
  const lint = new ESLint({ overrideConfigFile: resolve("tools/stock-request-layout-eslint.config.mjs") });
  const newLint = [];
  for (const file of files) {
    const messages = async source => (await lint.lintText(source, { filePath: file }))[0].messages
      .map(row => JSON.stringify([row.ruleId, row.severity, row.message]));
    newLint.push(...difference(await messages(readFileSync(file, "utf8")), await messages(existsSync(root + "/" + file) ? readFileSync(root + "/" + file, "utf8") : ""))
      .map(message => ({ file, message })));
  }
  const result = { baselineTypeErrors: previous.length, currentTypeErrors: current.length, newTypes, newLint };
  const tests = ["test/dispatch/frontend/local-reopen-actions.test.js", "test/dispatch/integration/local-reopen-workflows.test.js"];
  result.testLint = (await lint.lintFiles(tests)).flatMap(row => row.messages);
  writeFileSync(`${out}/static.json`, JSON.stringify(result, null, 2) + "\n");
  console.log(JSON.stringify(result));
  assert.deepEqual(newTypes, []);
  assert.deepEqual(newLint, []);
  assert.deepEqual(result.testLint, []);
} finally { rmSync(root, { recursive: true, force: true }); }
