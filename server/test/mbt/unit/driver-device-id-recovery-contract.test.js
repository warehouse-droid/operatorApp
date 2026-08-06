import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const dbSource = fs.readFileSync(
  new URL("../../../public/driver-offline-db.js", import.meta.url),
  "utf8"
);
const clientSource = fs.readFileSync(
  new URL("../../../public/driver.js", import.meta.url),
  "utf8"
);

function sourceSection(source, start, end) {
  const startIndex = source.indexOf(start);
  assert.notEqual(startIndex, -1, `Missing source section: ${start}`);
  const endIndex = source.indexOf(end, startIndex + start.length);
  assert.notEqual(endIndex, -1, `Missing source section terminator: ${end}`);
  return source.slice(startIndex, endIndex);
}

test("same-browser retained evidence restores its original device identity before partition unlock", () => {
  const recovery = sourceSection(
    dbSource,
    "async function recoverDriverDeviceIdentity(",
    "async function unlockPartition("
  );
  assert.match(recovery, /profiles[\s\S]*index\("byDriver"\)/u);
  assert.match(recovery, /getStorageHealth\((?:profile|candidate)\.partitionKey\)/u);
  assert.match(
    recovery,
    /pendingEventCount[\s\S]*reviewRequiredCount[\s\S]*partitionUnsyncedPhotoCount/u
  );
  assert.match(recovery, /store\.put\(\{ key: DEVICE_ID_KEY, value: recovered\.deviceId/u);
  assert.doesNotMatch(recovery, /delete\(/u);

  const login = sourceSection(
    clientSource,
    'app.addEventListener("submit",',
    "async function initializeOfflineStorage("
  );
  assert.match(
    login,
    /recoverDriverDeviceIdentity\(driver\)[\s\S]*unlockPartition\(driver\)/u
  );

  const sessionRestore = sourceSection(
    clientSource,
    "driverIdentityValidationPromise = (async () => {",
    "let nextJobError = null;"
  );
  assert.match(
    sessionRestore,
    /recoverDriverDeviceIdentity\(driver\)[\s\S]*unlockPartition\(driver\)/u
  );
});
