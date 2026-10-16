import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import {spawnSync} from "node:child_process";

if (process.env.MBT_TEST_ISOLATED !== "1") throw new Error("Use the disposable test runner.");
const source = fs.readFileSync("public/driver-upload.js", "utf8");
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "reconnect-mutants-"));
const mutants = [
  {name: "connection retry disabled", from: "if (!retryable(error)) throw error;", to: "throw error;"},
  {name: "retry cap doubled", from: "Math.min(30000, 1000 *", to: "Math.min(60000, 1000 *"},
  {name: "authorization failures are retried", from: "error.status >= 400 && error.status < 500", to: "error.status >= 450 && error.status < 500"},
  {name: "an already cancelled session starts work", from: "if (signal?.aborted) throw uploadError(\"driver_upload_cancelled\", \"Recovery paused. Your photos are retained.\");\n      try", to: "try"}
];
const results = [];
fs.mkdirSync("test-artifacts/final/mutations", {recursive: true});
try {
  for (const [index, mutant] of mutants.entries()) {
    if (source.split(mutant.from).length !== 2) throw new Error(`Mutation must be unique: ${mutant.name}`);
    const target = path.join(directory, `${index}.js`);
    fs.writeFileSync(target, source.replace(mutant.from, mutant.to));
    const layers = {};
    for (const [name, tests] of Object.entries({units: ["test/mbt/unit/driver-reconnect.test.js"], properties: ["test/mbt/property/driver-reconnect.test.js"]})) {
      const result = spawnSync(process.execPath, ["--test", ...tests], {env: {...process.env, DRIVER_UPLOAD_MODULE_FILE: target}, encoding: "utf8", timeout: 15000});
      fs.writeFileSync(`test-artifacts/final/mutations/${index}-${name}.log`, result.stdout + result.stderr);
      layers[name] = result.status !== 0 && /not ok /u.test(result.stdout);
    }
    // The exact delay cap is a generated property; unit recovery cases exercise
    // short retries and are not claimed to detect this independent invariant.
    results.push({name: mutant.name, ...layers});
  }
} finally {fs.rmSync(directory, {recursive: true, force: true});}
const restored = crypto.createHash("sha256").update(source).digest("hex") === crypto.createHash("sha256").update(fs.readFileSync("public/driver-upload.js")).digest("hex");
fs.writeFileSync("test-artifacts/final/mutations.json", JSON.stringify({restored, results}, null, 2));
console.log(JSON.stringify({restored, results}));
if (!restored || results.some(value => !value.properties)) process.exitCode = 1;
