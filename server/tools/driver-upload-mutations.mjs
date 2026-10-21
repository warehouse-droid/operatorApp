import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {spawnSync} from "node:child_process";

if (process.env.MBT_TEST_ISOLATED !== "1") throw new Error("Mutation execution requires the isolated test environment.");
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "driver-upload-mutants-"));
const mutants = [
  {name: "wrong byte weights", file: "public/driver-upload.js", variable: "DRIVER_UPLOAD_MODULE_FILE", from: "sum + weight * fractions[position]", to: "sum + fractions[position]", properties: true},
  {name: "uncapped percentages", file: "public/driver-upload.js", variable: "DRIVER_UPLOAD_MODULE_FILE", from: "Math.min(100, Number(value.percentage) || 0)", to: "(Number(value.percentage) || 0)", properties: true},
  {name: "oversized diagnostic queue", file: "public/driver-upload.js", variable: "DRIVER_UPLOAD_MODULE_FILE", from: "const QUEUE_LIMIT = 100;", to: "const QUEUE_LIMIT = 1000;"},
  {name: "silent upload failures", file: "public/driver-upload.js", variable: "DRIVER_UPLOAD_MODULE_FILE", from: "onFailure(diagnostic);", to: "void diagnostic;"},
  {name: "offline recovery no longer recognizes network failures", file: "public/driver-upload.js", variable: "DRIVER_UPLOAD_MODULE_FILE", from: "code === \"driver_photo_upload_network_error\" || code === \"driver_upload_timeout\"", to: "false"},
  {name: "storage quota discards memory diagnostics", file: "public/driver-upload.js", variable: "DRIVER_UPLOAD_MODULE_FILE", from: "storageUnavailable = true; /* The current session", to: "storageUnavailable = false; /* The current session"},
  {name: "authorization consumes the photo transfer budget", file: "public/driver-upload.js", variable: "DRIVER_UPLOAD_MODULE_FILE", from: "Math.min(API_TIMEOUT_MS, timeoutMs || API_TIMEOUT_MS)", to: "timeoutMs || photoTimeoutMs(photo)"},
  {name: "response body cannot be bounded or validated", file: "public/driver.js", variable: "DRIVER_UPLOAD_DRIVER_FILE", from: "return {response: result, text: await result.text()};", to: "return {response: result, text: \"\"};"},
  {name: "skipped save reconciliation", file: "public/driver.js", variable: "DRIVER_UPLOAD_DRIVER_FILE", from: "if (!driverUploadSaveChecks.has(key)) return null;", to: "if (true) return null;"},
  {name: "invalid failure identity accepted", file: "src/driver-upload-failure.js", variable: "DRIVER_UPLOAD_FAILURE_MODULE_FILE", from: "throw badField(\"failureId\");", to: "void failureId;"}
];
const report = [];
try {
  for (const [index, mutant] of mutants.entries()) {
    const source = fs.readFileSync(mutant.file, "utf8");
    if (source.split(mutant.from).length !== 2) throw new Error(`Mutation target is not unique: ${mutant.name}`);
    const target = path.join(directory, `mutant-${index}.mjs`);
    fs.writeFileSync(target, source.replace(mutant.from, mutant.to));
    const argumentsList = ["--test", "--test-concurrency=1", "test/mbt/unit/driver-upload-reliability.test.js", "test/mbt/unit/driver-upload-failure.test.js", "test/mbt/unit/driver-upload-lifecycle.test.js", "test/mbt/unit/driver-upload-request.test.js", "test/mbt/property/driver-upload-progress.test.js"];
    const result = spawnSync(process.execPath, argumentsList, {env: {...process.env, [mutant.variable]: target}, encoding: "utf8", timeout: 20000});
    fs.writeFileSync(`test-artifacts/mutant-${index}.log`, result.stdout + result.stderr);
    const killed = result.status !== 0 && /not ok /u.test(result.stdout);
    let propertyKilled = null;
    {
      const propertyResult = spawnSync(process.execPath, ["--test", "test/mbt/property/driver-upload-progress.test.js"], {env: {...process.env, [mutant.variable]: target}, encoding: "utf8", timeout: 20000});
      propertyKilled = propertyResult.status !== 0 && /not ok /u.test(propertyResult.stdout);
      fs.writeFileSync(`test-artifacts/mutant-${index}-properties.log`, propertyResult.stdout + propertyResult.stderr);
    }
    report.push({name: mutant.name, killed, propertyKilled, propertyExpected: Boolean(mutant.properties)});
    console.log(JSON.stringify(report.at(-1)));
  }
} finally { fs.rmSync(directory, {recursive: true, force: true}); }
fs.writeFileSync("test-artifacts/mutations.json", JSON.stringify(report, null, 2) + "\n");
if (report.some(item => !item.killed || (item.propertyExpected && !item.propertyKilled))) process.exitCode = 1;
