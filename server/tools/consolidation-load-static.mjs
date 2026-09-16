import { existsSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const directory = "test-artifacts/consolidation-load";
const label = process.argv[2] || "current";
const files = ["src/consolidation-load-domain.js", "src/consolidation-load-locks.js", "src/consolidation-load-repository.js", "src/consolidation-load-service.js", "src/consolidation-load-posting.js",
  "src/operator-yard-authorization.js", "src/server.js", "src/photo-upload.js", "src/delivery-repository.js", "src/operator-netsuite-posting-domain.js",
  "src/operator-netsuite-posting-controller.js", "src/operator-netsuite-posting-finalizer.js", "src/operator-netsuite-posting-service.js", "tools/mbt-predeploy-readiness.mjs", "public/operator.js", "public/operator-load-summary.js"].filter(existsSync);
for (const [name, command, args] of [
  ["types", "node_modules/.bin/tsc", ["--project", "tsconfig.mbt.json", "--noEmit", "--pretty", "false"]],
  ["lint", "node_modules/.bin/eslint", ["--config", "tools/consolidation-load-eslint.config.mjs", "--format", "json", ...files]]
]) {
  const result = spawnSync(command, args, { encoding: "utf8", maxBuffer: 30 * 1024 * 1024 });
  if (result.error) throw result.error;
  writeFileSync(`${directory}/${name}-${label}.log`, `${result.stdout}${result.stderr}`);
  console.log(JSON.stringify({ name, label, exitCode: result.status }));
}
