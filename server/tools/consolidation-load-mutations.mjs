import assert from "node:assert/strict";
import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const directory = "test-artifacts/consolidation-load";
const files = ["test/mbt/unit/consolidation-load.test.js", "test/mbt/unit/consolidation-load-posting.test.js"];
const mutations = [
  ["Zero quantity units leak into the summary", "public/operator-load-summary.js", "number(line[unit[0]]) > 0.000001", "number(line[unit[0]]) >= 0"],
  ["Duplicate item quantities overwrite instead of adding", "public/operator-load-summary.js", "group[field] += number(line[field])", "group[field] = number(line[field])"],
  ["Different physical loads are combined", "src/consolidation-load-domain.js", '["planId", "loadId", "planDate", "truckPlate"]', '["planId", "planDate", "truckPlate"]'],
  ["Snapshot hash ignores changed packed quantities", "src/consolidation-load-domain.js", "stableCanonicalJson(snapshot)", 'stableCanonicalJson({ locationId: snapshot.locationId })'],
  ["Sales Orders enter the native IF path at loading", "src/consolidation-load-posting.js", 'resolution.netSuitePostingOwner !== "driver_completion" && !resolution.localOnly', '!resolution.localOnly']
];
const reports = [];
for (const [index, [name, file, original, replacement]] of mutations.entries()) {
  const sandbox = mkdtempSync(path.join(tmpdir(), "consolidation-load-mutant-"));
  try {
    for (const folder of ["src", "public"]) cpSync(folder, path.join(sandbox, folder), { recursive: true });
    cpSync("package.json", path.join(sandbox, "package.json"));
    symlinkSync(path.resolve("node_modules"), path.join(sandbox, "node_modules"), "dir");
    for (const testFile of files) {
      mkdirSync(path.dirname(path.join(sandbox, testFile)), { recursive: true });
      cpSync(testFile, path.join(sandbox, testFile));
    }
    const target = path.join(sandbox, file), source = readFileSync(target, "utf8");
    assert.equal(source.split(original).length, 2, `Mutation anchor changed: ${name}`);
    writeFileSync(target, source.replace(original, replacement));
    const stages = [];
    for (const stage of ["focused", "properties-only"]) {
      const run = spawnSync(process.execPath, ["--test", ...(stage === "properties-only" ? ["--test-name-pattern=properties:"] : []), ...files], {
        cwd: sandbox, encoding: "utf8", env: { ...process.env, NODE_V8_COVERAGE: "" }, timeout: 60000
      });
      const output = `${run.stdout || ""}${run.stderr || ""}`;
      writeFileSync(`${directory}/mutation-${index + 1}-${stage}.log`, output);
      const killed = run.status !== 0 && /ERR_ASSERTION|Property failed after/.test(output) && !/ERR_MODULE_NOT_FOUND|SyntaxError/.test(output);
      stages.push({ stage, killed, exitCode: run.status });
      assert.ok(killed, `Mutation survived or failed for a non-behavioral reason: ${name} (${stage})`);
    }
    reports.push({ name, file, stages });
  } finally { rmSync(sandbox, { recursive: true, force: true }); }
}
writeFileSync(`${directory}/mutations.json`, `${JSON.stringify(reports, null, 2)}\n`);
console.log(JSON.stringify({ mutants: reports.length, focusedKilled: reports.length, propertiesOnlyKilled: reports.length }));
