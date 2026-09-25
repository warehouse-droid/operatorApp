import assert from "node:assert/strict";
import { cp, mkdir, readFile, writeFile, symlink } from "node:fs/promises";
import { spawnSync } from "node:child_process";

assert.equal(process.env.MBT_TEST_ISOLATED, "1");
const root = "/tmp/maps-daily-mutations";
await mkdir(root, { recursive: true });
for (const dir of ["src", "public", "test"]) await cp(dir, `${root}/${dir}`, { recursive: true });
await cp("package.json", `${root}/package.json`);
await symlink("/app/node_modules", `${root}/node_modules`);
await mkdir(`${root}/data`);
const policyTests = ["test/mbt/unit/google-maps-daily-capacity.test.js"];
const repositoryTests = ["test/mbt/integration/google-maps-daily-capacity.test.js"];
const mutations = [
  ["daily guard removed", "src/google-maps-usage-policy.js", "if (daily.used + requestedUnits > daily.limit)", "if (false)", policyTests],
  ["map-specific ceiling restored", "src/google-maps-usage-policy.js", "support_route: 400", "support_route: 400, dynamic_map: 300", policyTests],
  ["other automatic subsystem caps bypassed", "src/google-maps-usage-policy.js", "if (automatic && usesSharedReserve)", "if (false)", policyTests],
  ["reopen retries grant twice", "src/google-maps-usage-repository.js", "if (previous.rowCount)", "if (false)", repositoryTests],
  ["capacity revision ignored", "src/google-maps-usage-repository.js", "if (expectedLimit !== daily.limit)", "if (false)", repositoryTests],
  ["yesterday's grants retained", "src/google-maps-usage-repository.js", "WHERE day = (now() AT TIME ZONE 'UTC')::date", "WHERE day <= (now() AT TIME ZONE 'UTC')::date", repositoryTests],
  ["admin authorization removed", "src/server.js", 'app.post("/api/admin/maps-usage/reopen-daily", requireOperator, requireAdmin,', 'app.post("/api/admin/maps-usage/reopen-daily", requireOperator,', ["test/mbt/integration/google-maps-daily-http.test.js"]]
];
const results = [];
for (const [name, file, from, to, tests] of mutations) {
  const target = `${root}/${file}`;
  const source = await readFile(target, "utf8");
  assert.equal(source.split(from).length - 1, 1, name);
  try {
    await writeFile(target, source.replace(from, to));
    const result = spawnSync(process.execPath, ["--test", "--test-concurrency=1", ...tests], {
      cwd: root, env: process.env, encoding: "utf8", timeout: 45_000
    });
    await writeFile(`test-artifacts/maps-daily-capacity/mutant-${results.length + 1}.log`, result.stdout + result.stderr);
    assert.equal(result.signal, null, `${name}: test timed out`);
    assert.notEqual(result.status, 0, `${name}: survived`);
    assert.match(result.stdout, /not ok/u, `${name}: failure must come from a test`);
    results.push({ name, killed: true });
    console.log(`Killed: ${name}`);
  } finally {
    await writeFile(target, source);
  }
}
await writeFile("test-artifacts/maps-daily-capacity/mutations.json", JSON.stringify(results, null, 2));
console.log(`${results.length}/${mutations.length} mutations killed; workspace sources never modified.`);
