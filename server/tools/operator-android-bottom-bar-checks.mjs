import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { ESLint } from "eslint";

const file = "public/operator-viewport.js";
const lint = new ESLint({ overrideConfigFile: true, overrideConfig: [{
  files: [file], languageOptions: { sourceType: "script", globals: Object.fromEntries(
    ["navigator", "window", "document", "screen", "sessionStorage", "MutationObserver"].map(name => [name, "readonly"])) },
  rules: { "no-undef": "error", "no-unused-vars": "error", "no-unreachable": "error", eqeqeq: "error", "no-var": "error" },
}] });
const messages = (await lint.lintFiles([file])).flatMap(row => row.messages);
assert.deepEqual(messages, []);
const types = spawnSync("node_modules/.bin/tsc", ["--ignoreConfig", "--allowJs", "--checkJs", "--noEmit", "--noResolve", "--skipLibCheck", "--target", "ES2022", file], { encoding: "utf8" });
assert.equal(types.status, 0, types.stdout + types.stderr);
const html = await readFile("public/operator.html", "utf8");
const worker = await readFile("public/service-worker.js", "utf8");
for (const asset of ["operator.css", "operator-viewport.js"]) {
  const url = `/${asset}?v=20260930-android-bottom-bar-v1`;
  assert.ok(html.includes(url)); assert.ok(worker.includes(url));
}
for (const asset of ["operator.js", "operator-inventory.js"]) {
  assert.deepEqual(await readFile(`public/${asset}`), await readFile(`/release/baseline/public/${asset}`));
}
const result = { lintDiagnostics: messages.length, typeDiagnostics: 0, versionedAssets: 2, cameraScriptsUnchanged: true };
await writeFile("/release/static.json", JSON.stringify(result, null, 2));
console.log(JSON.stringify(result));
