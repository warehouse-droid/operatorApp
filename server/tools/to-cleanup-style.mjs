import { ESLint } from "eslint";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
const files = ["src/dispatch-fulfilled-to-policy.js", "src/dispatch-fulfilled-to-repository.js", "tools/to-cleanup-domain.mjs", "tools/to-cleanup-repository.mjs",
  "tools/to-cleanup-cli.mjs", "tools/to-cleanup-netsuite-read.mjs", "tools/to-cleanup-rehearse.mjs", "tools/to-cleanup-mutations.mjs"];
const lint = new ESLint({ overrideConfigFile: "tools/to-cleanup-eslint.config.mjs", fix: true });
let errors = 0;
for (const file of files) {
  const result = (await lint.lintText(readFileSync(file, "utf8"), { filePath: file }))[0];
  const target = path.join("test-artifacts/to-cleanup-20260915/style", file); mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, result.output || readFileSync(file, "utf8"));
  if (result.messages.length) console.log(JSON.stringify({ file, messages: result.messages }));
  errors += result.errorCount;
}
console.log(JSON.stringify({ errors })); process.exitCode = errors ? 1 : 0;
