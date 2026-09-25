import assert from "node:assert/strict";
import { cp, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";

const root = "/tmp/maps-daily-baseline";
await mkdir(root, { recursive: true });
for (const dir of ["src", "public", "test"]) await cp(dir, `${root}/${dir}`, { recursive: true });
await cp("package.json", `${root}/package.json`);
await symlink("/app/node_modules", `${root}/node_modules`);
await cp("test-artifacts/maps-daily-capacity/baseline", root, { recursive: true });
const result = spawnSync(process.execPath, ["--test", "test/dispatch/frontend/google-maps-usage-control.contract.test.js"], {
  cwd: root, env: process.env, encoding: "utf8", timeout: 30_000
});
await writeFile("test-artifacts/maps-daily-capacity/baseline.log", result.stdout + result.stderr);
const failures = [...result.stdout.matchAll(/^not ok \d+ - (.+)$/gm)].map((match) => match[1]);
assert.deepEqual(failures, ["dispatch rendering and autosave never trigger route API work"]);
assert.match(result.stdout, /serializeDispatchPlanAction/u);
await writeFile("test-artifacts/maps-daily-capacity/baseline-failures.json", JSON.stringify(failures));
console.log("Confirmed one existing source-contract failure in unchanged Dispatch confirmation delegation.");
