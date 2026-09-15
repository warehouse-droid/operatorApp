import { existsSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const directory = "test-artifacts/operator-yard-access";
const label = process.argv[2] || "current";
const files = ["src/operator-yard-access.js", "src/operator-yard-authorization.js", "src/auth-repository.js", "src/history-repository.js",
  "src/inventory-repository.js", "src/server.js", "src/return-repository.js", "src/photo-upload.js", "src/delivery-repository.js", "src/delivery-consolidation-repository.js",
  "test/mbt/unit/operator-yard-access.test.js", "test/mbt/unit/operator-yard-assets.test.js", "test/mbt/integration/operator-yard-access.test.js",
  "test/dispatch/frontend/operator-yard-access.browser.test.mjs", "tools/operator-yard-coverage.mjs", "tools/operator-yard-mutations.mjs",
  "tools/operator-yard-full-suite.mjs", "tools/operator-yard-e2e.mjs", "tools/operator-yard-static.mjs"]
  .filter((file) => existsSync(file) && (label !== "baseline" || !file.includes("operator-yard-")));
for (const [name, command, args] of [
  ["types", "node_modules/.bin/tsc", ["--project", "tsconfig.mbt.json", "--noEmit", "--pretty", "false"]],
  ["lint", "node_modules/.bin/eslint", ["--config", "test/support/operator-yard-eslint.config.mjs", "--format", "json", ...files]]
]) {
  const result = spawnSync(command, args, { encoding: "utf8", maxBuffer: 20 * 1024 * 1024 });
  if (result.error) { throw result.error; }
  writeFileSync(`${directory}/${name}-${label}.log`, `${result.stdout}${result.stderr}`);
  console.log(JSON.stringify({ name, label, exitCode: result.status }));
}
