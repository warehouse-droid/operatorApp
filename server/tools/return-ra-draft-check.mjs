import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { scanTextForSecrets } from "../test/support/scan-diff-secrets.mjs";

const out = resolve("test-artifacts/return-stored-orderline/ra-draft");
mkdirSync(out, { recursive: true });
const files = ["unit/return-stored-orderline", "integration/return-stored-orderline", "unit/return-batch-ra-domain",
  "unit/return-ra-workflow", "unit/return-ra-client", "integration/return-batch-ra", "integration/return-ra-workflow",
  "integration/stock-return-draft-insert", "integration/netsuite-order-line-storage", "integration/operator-direct-orderline",
  "unit/return-rest-units", "integration/return-failed-draft"].map(file => "test/mbt/" + file + ".test.js");
const runtime = ["src/return-batch-ra-domain.js", "src/return-batch-ra-service.js", "src/return-netsuite.js",
  "src/return-repository.js", "src/return-submission-draft.js"];
function run(name, args, { cwd = process.cwd(), input, accepted = [0] } = {}) {
  const result = spawnSync(process.execPath, args, { cwd, input, encoding: "utf8", maxBuffer: 100e6, timeout: 150000 });
  assert.ifError(result.error);
  const output = result.stdout + result.stderr;
  writeFileSync(join(out, name + ".log"), output);
  assert.ok(accepted.includes(result.status), `${name}: exit ${result.status}; see ${name}.log`);
  return { output, status: result.status };
}
function counts(output) {
  return Object.fromEntries(["tests", "pass", "fail", "skipped"].map(key => [key, Number(output.match(new RegExp(`^# ${key} (\\d+)$`, "m"))?.[1])]));
}
const coverage = join(out, "coverage");
rmSync(coverage, { recursive: true, force: true });
let count, shuffle;
function focusedChecks() {
const main = run("focused", ["node_modules/c8/bin/c8.js", "--all=false", "--check-coverage=false",
  ...runtime.map(file => "--include=" + file), "--reporter=json", "--reporter=json-summary", "--report-dir=" + coverage,
  "--temp-directory=" + join(coverage, "tmp"), process.execPath, "--test", "--test-concurrency=1", ...files]);
count = counts(main.output);
assert.equal(count.tests, 111); assert.equal(count.pass, 111); assert.equal(count.fail, 0); assert.equal(count.skipped, 0);
shuffle = counts(run("reversed", ["--test", "--test-concurrency=1", ...files.toReversed()]).output);
assert.deepEqual(shuffle, count);
}
for (const file of [...runtime, "src/server.js", "public/operator.js", "public/service-worker.js"]) run("syntax-" + file.replaceAll("/", "-"), ["--check", file]);

const scratch = mkdtempSync(join(tmpdir(), "return-ra-draft-check-"));
const mutations = [];
try {
  mkdirSync(join(scratch, "src"));
  cpSync("src/return-submission-draft.js", join(scratch, "src/return-submission-draft.js"));
  writeFileSync(join(scratch, "src/db.d.ts"), "export function query(text:string,params?:any[]):Promise<{rows:any[],rowCount:number}>; export function withTransaction<T>(fn:()=>Promise<T>):Promise<T>;");
  writeFileSync(join(scratch, "src/auth-repository.d.ts"), "export function writeAudit(value:Record<string,any>):Promise<void>;");
  writeFileSync(join(scratch, "package.json"), '{"type":"module"}');
  run("types-helper", ["node_modules/typescript/bin/tsc", "--allowJs", "--checkJs", "--strict", "--noEmit", "--skipLibCheck",
    "--target", "es2023", "--module", "nodenext", join(scratch, "src/return-submission-draft.js")]);
  run("types-domain", ["node_modules/typescript/bin/tsc", "--allowJs", "--checkJs", "--strict", "--noEmit", "--skipLibCheck",
    "--target", "es2023", "--module", "nodenext", "src/return-batch-ra-domain.js"]);
  const lint = (file, source, name) => {
    const args = ["node_modules/eslint/bin/eslint.js", "--config", "tools/return-ra-eslint.config.mjs", "--format=json"];
    const output = run(name, source === null ? [...args, file] : [...args, "--stdin", "--stdin-filename", file], { input: source, accepted: [0, 1] }).output;
    return JSON.parse(output).flatMap(row => row.messages.map(message => `${message.ruleId}:${message.message}`));
  };
  const lintCounts = {};
  for (const file of runtime) {
    const before = file.endsWith("return-submission-draft.js") ? [] : lint(file, readFileSync(join(out, "baseline", file), "utf8"), "lint-before-" + file.replaceAll("/", "-"));
    const after = lint(file, null, "lint-after-" + file.replaceAll("/", "-"));
    const normalize = message => message.replace(/on line \d+ column \d+/g, "on the existing scope");
    const retained = before.map(normalize);
    const added = after.map(normalize).filter(message => {
      const score = message.match(/complexity of (\d+)/);
      const index = retained.findIndex(old => old === message || (score
        && old.replace(/complexity of \d+/, "complexity") === message.replace(/complexity of \d+/, "complexity")
        && Number(old.match(/complexity of (\d+)/)?.[1]) >= Number(score[1])));
      if (index < 0) return true;
      retained.splice(index, 1); return false;
    });
    assert.deepEqual(added, [], file);
    lintCounts[file] = { before: before.length, after: after.length };
    const addedText = readFileSync(file, "utf8").split("\n").filter(line => file.endsWith("return-submission-draft.js") || !readFileSync(join(out, "baseline", file), "utf8").split("\n").includes(line)).join("\n");
    assert.deepEqual(scanTextForSecrets(addedText, file), []);
  }
  writeFileSync(join(out, "lint-counts.json"), JSON.stringify(lintCounts));
  focusedChecks();
  cpSync("src", join(scratch, "src"), { recursive: true });
  cpSync("test", join(scratch, "test"), { recursive: true });
  symlinkSync(resolve("node_modules"), join(scratch, "node_modules"), "dir");
  symlinkSync(resolve("public"), join(scratch, "public"), "dir");
  const cases = [
    ["batch-unit-object", runtime[0], "units: String(line.salesUomId)", "units: { id: String(line.salesUomId) }", files.at(-2)],
    ["legacy-unit-object", runtime[2], "units: String(line.salesUomId)", "units: { id: String(line.salesUomId) }", files.at(-2)],
    ["discard-uncertain-attempt", runtime[4], 'batch.sync_status === "failed" && !batch.attempted_at && !batch.netsuite_transaction_id', "true", files.at(-1)],
    ["publish-before-RA", runtime[4], 'await query("DELETE FROM return_records WHERE batch_id=$1", [batchId]);', "void batchId;", files.at(-1)],
    ["ignore-staged-input", runtime[3], "JSON.stringify(fields(input)) !== JSON.stringify(fields(saved.payload))", "false", files.at(-1)],
    ["permit-uncertain-RA-recreation", runtime[1], "if (batch.attempted_at)", "if (false)", files.at(-1),
      "WHERE batch_id=$1 AND attempted_at IS NULL AND netsuite_transaction_id IS NULL RETURNING batch_id",
      "WHERE batch_id=$1 AND netsuite_transaction_id IS NULL RETURNING batch_id"],
    ["ignore-staged-reservation", runtime[3], "a.draft_id IS NOT NULL AND line->>'kind'='stock'", "false AND line->>'kind'='stock'", files.at(-1)]
  ];
  for (const [name, file, from, to, testFile, secondFrom, secondTo] of cases) {
    const original = readFileSync(file, "utf8");
    assert.equal(original.split(from).length - 1, 1, name);
    let mutated = original.replace(from, to);
    if (secondFrom) {
      assert.equal(mutated.split(secondFrom).length - 1, 1, name);
      mutated = mutated.replace(secondFrom, secondTo);
    }
    writeFileSync(join(scratch, file), mutated);
    const result = run("mutant-" + name, ["--test", "--test-concurrency=1", testFile], { cwd: scratch, accepted: [0, 1] });
    assert.equal(result.status, 1, "surviving mutant: " + name);
    assert.match(result.output, /not ok/);
    let propertyOnly = null;
    if (["batch-unit-object", "publish-before-RA"].includes(name)) {
      const property = run("property-mutant-" + name, ["--test", "--test-concurrency=1", "--test-name-pattern="
        + (name === "batch-unit-object" ? "U3 arbitrary" : "F7 arbitrary"), testFile], { cwd: scratch, accepted: [0, 1] });
      assert.equal(property.status, 1, "property invariant did not kill " + name);
      assert.match(property.output, /not ok/);
      propertyOnly = true;
    }
    mutations.push({ name, killed: true, editedGuards: secondFrom ? 2 : 1, propertyOnly });
    writeFileSync(join(scratch, file), original);
  }
} finally { rmSync(scratch, { recursive: true, force: true }); }
const summary = JSON.parse(readFileSync(join(coverage, "coverage-summary.json"), "utf8"));
const helper = summary[resolve("src/return-submission-draft.js")];
assert.ok(helper.lines.pct === 100 && helper.functions.pct === 100, JSON.stringify(helper));
const evidence = { passed: true, counts: count, reversed: shuffle, strictTypes: true,
  typeBoundary: "Database/audit declarations for the new helper; full domain module", newLintFindings: 0,
  secretFindings: 0, helperCoverage: helper, mutations, propertyExamples: 112 };
writeFileSync(join(out, "checks.json"), JSON.stringify(evidence, null, 2));
console.log(JSON.stringify(evidence));
