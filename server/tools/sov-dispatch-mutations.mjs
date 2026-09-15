import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

assert.equal(process.env.MBT_TEST_ISOLATED, "1");
const root = await mkdtemp(join(tmpdir(), "sov-mutants-"));
const mutants = [
  ["treat 195 as a vendor", "dispatch-load-assignment.js", 'if (ownYard) {', 'if (ownYard && normalizedYardLocationText(location) !== "195") {'],
  ["retroactive pickup", "scm-dependency-plan-reconciler.js", 'if (protectedIds.has(text(drop.id))) {continue;}', 'if (false) {continue;}'],
  ["reuse completed pickup", "scm-dependency-plan-reconciler.js", '(!isSov || !protectedIds.has(text(stop.id)) || refs(stop.orderRefs || [stop.orderId]).includes(targetRef))', 'true'],
  ["duplicate pickups", "scm-dependency-plan-reconciler.js", 'if (priorPickup) {', 'if (false) {'],
  ["missing visit allocation", "scm-dependency-plan-reconciler.js", '...(isSov ? { orderRefs: [targetRef] } : {})', '...{}']
];
try {
  await cp("src", join(root, "src"), { recursive: true });
  await cp("test", join(root, "test"), { recursive: true });
  await cp("tools", join(root, "tools"), { recursive: true });
  await cp("package.json", join(root, "package.json"));
  await symlink(join(process.cwd(), "node_modules"), join(root, "node_modules"));
  const baseline = spawnSync(process.execPath, ["--test", "test/dispatch/unit/sov-dispatch.test.js"], { cwd: root, encoding: "utf8" });
  assert.equal(baseline.status, 0, baseline.stdout + baseline.stderr);
  for (const [name, file, from, to] of mutants) {
    const target = join(root, "src", file);
    const source = await readFile(target, "utf8");
    assert.equal(source.split(from).length, 2, `Mutation anchor must be unique: ${name}`);
    for (const propertiesOnly of [false, true]) {
      await writeFile(target, source.replace(from, to));
      const result = spawnSync(process.execPath, ["--test", ...(propertiesOnly ? ["--test-name-pattern=SOV-10|property:"] : []),
        "test/dispatch/unit/sov-dispatch.test.js"], { cwd: root, encoding: "utf8" });
      assert.equal(result.status, 1, `Survived or could not execute: ${name}\n${result.stdout}\n${result.stderr}`);
      assert.match(result.stdout, /not ok/u);
      process.stdout.write(`${JSON.stringify({ name, propertiesOnly, killed: true })}\n`);
    }
    await writeFile(target, source);
  }
  const restored = spawnSync(process.execPath, ["--test", "test/dispatch/unit/sov-dispatch.test.js"], { cwd: root, encoding: "utf8" });
  assert.equal(restored.status, 0, restored.stdout + restored.stderr);
  process.stdout.write(`${JSON.stringify({ mutantsKilled: mutants.length, propertiesKilled: mutants.length, restored: true })}\n`);
} finally {
  await rm(root, { recursive: true, force: true });
}
