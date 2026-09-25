import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { writeFile } from "node:fs/promises";

const files = [
  "test/mbt/integration/google-maps-daily-http.test.js",
  "test/mbt/unit/google-maps-daily-capacity.test.js",
  "test/dispatch/frontend/google-maps-daily-capacity.test.js",
  "test/mbt/integration/google-maps-daily-capacity.test.js"
];
const results = [];
for (const file of files) {
  const result = spawnSync(process.execPath, ["--test", file], { encoding: "utf8", timeout: 30_000 });
  await writeFile(`test-artifacts/maps-daily-capacity/health-${results.length + 1}.log`, result.stdout + result.stderr);
  assert.equal(result.status, 0, `${file}: ${result.stdout}\n${result.stderr}`);
  results.push({ file, tests: Number(result.stdout.match(/# tests (\d+)/u)[1]), passed: true });
}
await writeFile("test-artifacts/maps-daily-capacity/suite-health.json", JSON.stringify(results, null, 2));
console.log(`${results.reduce((sum, row) => sum + row.tests, 0)} tests passed in a different file order.`);
