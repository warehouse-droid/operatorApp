import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import {spawnSync} from "node:child_process";

if (process.env.MBT_TEST_ISOLATED !== "1") throw new Error("Use the disposable test harness.");
const sourcePath = "public/driver.js";
const source = fs.readFileSync(sourcePath, "utf8");
const digest = text => crypto.createHash("sha256").update(text).digest("hex");
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "driver-recovery-mutants-"));
const report = [];
const mutants = [
  {name: "automatic confirmation disabled", from: "stage === \"saving\" && driverPhotoSaveMayHaveCompleted(error)", to: "false", propertyExpected: true},
  {name: "a different completed stop is accepted", from: "record.details?.jobId === job.jobId && record.status === \"complete\"", to: "record.status === \"complete\"", propertyExpected: true},
  {name: "an incomplete matching stop is accepted", from: "record.details?.jobId === job.jobId && record.status === \"complete\"", to: "record.details?.jobId === job.jobId", propertyExpected: true},
  {name: "cache deadline bypassed", from: "await window.DriverUpload.deadline(task, {signal: scope.signal, timeoutMs: 5000});", to: "await task();", propertyExpected: false},
  {name: "cancelled reconciliation loses its cancellation", from: "assertDriverUploadScope(scope);\n        recordDriverPhotoActionFailure(checkError", to: "void scope;\n        recordDriverPhotoActionFailure(checkError", propertyExpected: false}
];
fs.mkdirSync("test-artifacts/mutations", {recursive: true});
try {
  for (const [index, mutant] of mutants.entries()) {
    if (source.split(mutant.from).length !== 2) throw new Error(`Nonunique mutation: ${mutant.name}`);
    const file = path.join(directory, `mutant-${index}.js`);
    fs.writeFileSync(file, source.replace(mutant.from, mutant.to));
    const env = {...process.env, DRIVER_UPLOAD_DRIVER_FILE: file};
    const run = (suffix, tests) => {
      const result = spawnSync(process.execPath, ["--test", "--test-concurrency=1", ...tests], {env, encoding: "utf8", timeout: 20000});
      fs.writeFileSync(`test-artifacts/mutations/${index}-${suffix}.log`, result.stdout + result.stderr);
      return result.status !== 0 && /not ok /u.test(result.stdout);
    };
    const killed = run("unit", ["test/mbt/unit/driver-upload-recovery.test.js", "test/mbt/unit/driver-upload-lifecycle.test.js"]);
    const propertyKilled = run("properties", ["test/mbt/property/driver-upload-recovery.test.js"]);
    report.push({name: mutant.name, killed, propertyKilled, propertyExpected: mutant.propertyExpected});
    console.log(JSON.stringify(report.at(-1)));
  }
} finally { fs.rmSync(directory, {recursive: true, force: true}); }
const restored = digest(fs.readFileSync(sourcePath, "utf8")) === digest(source);
fs.writeFileSync("test-artifacts/mutations/result.json", JSON.stringify({restored, mutants: report}, null, 2) + "\n");
if (!restored || report.some(row => !row.killed || (row.propertyExpected && !row.propertyKilled))) process.exitCode = 1;
