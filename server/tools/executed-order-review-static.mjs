import { existsSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";

const label = process.argv[2] || "current";
const artifact = "test-artifacts/executed-order-review";
const manifest = JSON.parse(readFileSync(new URL("./executed-order-review-files.json", import.meta.url), "utf8"));
const files = [...manifest.production, ...manifest.tests,
  ...readdirSync("tools").filter(file => /^executed-order-review.*\.mjs$/u.test(file)).map(file => `tools/${file}`)]
  .filter(file => /\.(js|mjs)$/u.test(file) && existsSync(file));
for (const file of files) {
  const result = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
  if (result.status !== 0) {throw new Error(`${file}: ${result.stderr}`);}
}
for (const [name, command, args] of [
  ["types", "node_modules/.bin/tsc", ["--project", "tsconfig.mbt.json", "--noEmit", "--pretty", "false"]],
  ["lint", "node_modules/.bin/eslint", ["--config", new URL("./executed-order-review-eslint.config.mjs", import.meta.url).pathname, "--format", "json", ...files]]
]) {
  const result = spawnSync(command, args, { encoding: "utf8", maxBuffer: 30 * 1024 * 1024 });
  if (result.error) {throw result.error;}
  writeFileSync(`${artifact}/${name}-${label}-final.log`, result.stdout);
  if (result.stderr) {throw new Error(result.stderr);}
  console.log(JSON.stringify({ name, label, exitCode: result.status, syntaxFiles: files.length }));
}
