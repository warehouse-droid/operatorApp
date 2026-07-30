import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beginRollbackContext, closeDb, query } from "./db.js";
import {
  getDispatchDriverByLogin,
  replaceDispatchFleetSetup
} from "./dispatch-setup-repository.js";
import {
  ensureDriverSamsaraDutyForJob,
  getDriverDayState,
  submitDriverDvir
} from "./driver-repository.js";

const dirname = path.dirname(fileURLToPath(import.meta.url));
const serverRoot = path.resolve(dirname, "..");

function sourceSection(source, start, end) {
  const startIndex = source.indexOf(start);
  assert.notEqual(startIndex, -1, `Missing source section: ${start}`);
  const endIndex = end ? source.indexOf(end, startIndex + start.length) : source.length;
  assert.notEqual(endIndex, -1, `Missing source section terminator: ${end}`);
  return source.slice(startIndex, endIndex);
}

const [
  migration,
  setupRepositorySource,
  driverRepositorySource,
  serverSource,
  setupUiSource,
  driverUiSource
] = await Promise.all([
  fs.readFile(path.join(serverRoot, "migrations/078_dispatch_driver_samsara_setting.sql"), "utf8"),
  fs.readFile(path.join(dirname, "dispatch-setup-repository.js"), "utf8"),
  fs.readFile(path.join(dirname, "driver-repository.js"), "utf8"),
  fs.readFile(path.join(dirname, "server.js"), "utf8"),
  fs.readFile(path.join(serverRoot, "public/dispatch-setup.js"), "utf8"),
  fs.readFile(path.join(serverRoot, "public/driver.js"), "utf8")
]);

assert.match(
  migration,
  /ADD COLUMN IF NOT EXISTS samsara_enabled boolean NOT NULL DEFAULT false/i,
  "The database setting must be non-null and default off."
);
assert.match(
  migration,
  /DVIR, vehicle assignment, duty-status writes, and primary\/secondary account handoff[\s\S]*Read-only fleet GPS verification remains enabled/i,
  "The migration does not document the write-workflow boundary and always-on GPS verification."
);

assert.match(
  setupRepositorySource,
  /samsaraEnabled:\s*driver\.samsaraEnabled === true \|\| driver\.connectSamsara === true/,
  "Dispatch Setup does not normalize the per-driver Samsara checkbox."
);
assert.match(
  setupRepositorySource,
  /samsaraEnabled:\s*row\.samsara_enabled === true/,
  "Dispatch Setup does not return the saved Samsara setting."
);
assert.match(
  setupRepositorySource,
  /samsara_enabled = \$9/,
  "Driver updates do not persist the Samsara setting."
);
assert.match(
  setupRepositorySource,
  /samsara_primary_login, samsara_secondary_login, samsara_enabled/,
  "New drivers do not persist the Samsara setting."
);

assert.match(
  serverSource,
  /const hasSamsaraSetting = Object\.hasOwn\(driver \|\| \{\}, "connectSamsara"\)[\s\S]{0,420}existing\?\.samsaraEnabled === true/,
  "A legacy Dispatch Setup save can silently turn off an existing driver's Samsara setting."
);
assert.match(
  serverSource,
  /function samsaraAccountsForDriver\(driver\)[\s\S]{0,180}enabled: driverSamsaraWorkflowEnabled\(driver\)/,
  "Driver repository calls do not receive the per-driver enabled state."
);

for (const [start, end] of [
  ['app.post("/api/driver/dvir",', 'app.post("/api/driver/dvir/skip",'],
  ['app.post("/api/driver/dvir/skip",', 'app.post("/api/driver/samsara-auth-token",'],
  ['app.post("/api/driver/samsara-auth-token",', 'app.post("/api/driver/samsara-duty-status",'],
  ['app.post("/api/driver/samsara-duty-status",', 'app.get("/api/driver/next-job",']
]) {
  assert.match(
    sourceSection(serverSource, start, end),
    /if \(!driverSamsaraWorkflowEnabled\(req\.driver\)\) return driverSamsaraDisabledResponse\(res\);/,
    `${start} can still contact Samsara while the driver setting is off.`
  );
}

const dvirUploadTokenRoute = sourceSection(
  serverSource,
  'app.post("/api/driver/photo-upload-token",',
  'app.get("/api/driver/day-state",'
);
assert.match(
  dvirUploadTokenRoute,
  /!driverSamsaraWorkflowEnabled\(req\.driver\)[\s\S]{0,220}recordType[\s\S]{0,220}dvir/,
  "A stale Driver PWA can still obtain a DVIR photo-upload token while the workflow is off."
);

const locationRoute = sourceSection(
  serverSource,
  'app.post("/api/driver/jobs/:jobId/location-check",',
  'app.post("/api/driver/jobs/:jobId/photos",'
);
assert.match(
  locationRoute,
  /res\.json\(await checkDriverJobLocation\(job\)\);/,
  "The location endpoint must always perform the read-only Samsara GPS verification."
);
assert.doesNotMatch(
  locationRoute,
  /driverSamsaraWorkflowEnabled|driverLocationCheckNotRequired/,
  "The per-driver write-workflow setting must not bypass the read-only GPS endpoint."
);

const completionRoute = sourceSection(
  serverSource,
  'app.post("/api/driver/jobs/:jobId/photos",',
  'app.get("/api/operators",'
);
assert.match(
  completionRoute,
  /const locationCheck = await checkDriverJobLocation\(job\);/,
  "Job completion must always re-run the read-only Samsara GPS verification."
);
assert.doesNotMatch(
  sourceSection(completionRoute, "const locationCheck =", "if (locationCheck.status"),
  /driverSamsaraWorkflowEnabled|driverLocationCheckNotRequired/,
  "The per-driver write-workflow setting must not bypass the completion GPS gate."
);

assert.match(
  setupUiSource,
  /name="samsaraEnabled" type="checkbox"/,
  "Dispatch Setup is missing the per-driver Samsara checkbox."
);
assert.match(
  setupUiSource,
  /Off by default\. When off, Driver PWA skips pre\/post DVIR, vehicle assignment, duty-status writes, and primary\/secondary account handoff\. Read-only GPS location verification remains active\./,
  "Dispatch Setup does not clearly explain what the setting controls."
);
assert.match(
  setupUiSource,
  /samsaraEnabled:\s*data\.samsaraEnabled === "on"/,
  "The Dispatch Setup form does not submit the Samsara checkbox."
);
assert.match(
  setupUiSource,
  /selectedActive && selected\.samsaraEnabled === true \? "" : "disabled"/,
  "Samsara driver lookup remains available while the setting is off."
);

assert.match(
  driverUiSource,
  /function driverUsesSamsaraWorkflow\(\)[\s\S]{0,220}dayState\?\.samsaraEnabled[\s\S]{0,120}driver\?\.samsaraEnabled/,
  "Driver PWA does not consume the per-driver Samsara setting."
);
const gpsUi = sourceSection(
  driverUiSource,
  "function locationCheckApproved()",
  "function renderLogin("
);
assert.match(gpsUi, /await request\(`\/api\/driver\/jobs\/\$\{encodeURIComponent\(currentJob\.jobId\)\}\/location-check`/);
assert.doesNotMatch(
  gpsUi,
  /driverUsesSamsaraWorkflow|notRequired/,
  "Driver PWA GPS verification must not be bypassed by the write-workflow setting."
);
const loadNextJobUi = sourceSection(
  driverUiSource,
  "async function loadNextJob()",
  "function connectEvents()"
);
assert.match(
  loadNextJobUi,
  /if \(driverUsesSamsaraWorkflow\(\) && dayState\?\.truckPlate &&/,
  "Driver PWA pre-DVIR is not gated by the setting."
);
assert.match(
  loadNextJobUi,
  /return renderDvir\("pre", message\);/,
  "Driver PWA no longer renders the enabled pre-DVIR gate."
);
assert.match(
  loadNextJobUi,
  /if \(driverUsesSamsaraWorkflow\(\) && !currentJob && dayState\?\.allJobsComplete[\s\S]{0,220}return renderDvir\("post"/,
  "Driver PWA post-DVIR is not gated by the setting."
);
assert.match(
  driverUiSource,
  /driverUsesSamsaraWorkflow\(\) \? `<button class="secondary danger-button skip-samsara-button"/,
  "Driver PWA still exposes the Samsara truck-switch action while disabled."
);
assert.match(
  driverUiSource,
  /showToast\("Job started"\);\s*checkCurrentJobLocation\(\)\.catch/,
  "Driver PWA must run GPS verification after every job start, even when write workflows are off."
);
assert.match(
  driverUiSource,
  /if \(shouldCheckNext\) checkCurrentJobLocation\(\)\.catch/,
  "Driver PWA must run GPS verification when the next job auto-starts."
);

assert.match(
  driverRepositorySource,
  /if \(!normalizedSamsaraAccounts\.enabled\) \{\s*return \{ switched: false, reason: "samsara_disabled", account: "" \};/,
  "The 8-hour account handoff does not exit before Samsara work when disabled."
);
assert.match(
  driverRepositorySource,
  /if \(!normalizedSamsaraAccounts\.enabled\) \{[\s\S]{0,220}code: "DRIVER_SAMSARA_DISABLED"/,
  "Direct DVIR submission is not rejected when Samsara is disabled."
);
const localTruckSwitch = sourceSection(
  driverRepositorySource,
  "async function completeDriverTruckSwitchLocally(",
  "export async function confirmDriverTruckSwitch("
);
assert.doesNotMatch(
  localTruckSwitch,
  /createSamsaraDriverVehicleAssignment|setSamsaraDriverDutyStatus|createSamsaraMechanicDvir/,
  "The disabled truck-switch path can still write to Samsara."
);
const truckSwitch = sourceSection(
  driverRepositorySource,
  "export async function confirmDriverTruckSwitch(",
  "export async function overrideDriverTruckSwitch("
);
assert.match(
  truckSwitch,
  /if \(!normalizedAccounts\.enabled\) \{\s*return completeDriverTruckSwitchLocally\(driverLogin, job, row\.id\);\s*\}/,
  "A disabled driver does not take the local-only truck-switch path."
);
assert.ok(
  truckSwitch.indexOf("return completeDriverTruckSwitchLocally(driverLogin, job, row.id);")
    < truckSwitch.indexOf("createSamsaraDriverVehicleAssignment({"),
  "The truck-switch write guard must run before any Samsara vehicle assignment."
);
assert.match(
  driverRepositorySource,
  /preDvirStatus:\s*!samsaraEnabled[\s\S]{0,80}\? "complete"/,
  "Disabled day state is not compatible with older cached Driver PWA clients."
);
assert.match(
  driverRepositorySource,
  /samsaraOnDutyConfirmed:\s*!samsaraEnabled \|\|/,
  "Disabled day state can still fail the legacy Samsara confirmation gate."
);

const rollback = await beginRollbackContext();
const suffix = `${Date.now()}-${process.pid}`.replace(/\D/g, "").slice(-14);
const driverLogin = `samsara-setting-${suffix}`;
const untouchedLogin = `samsara-safety-${suffix}`;
const fixture = {
  name: `Samsara Setting Harness ${suffix}`,
  license: "AZ",
  number: `H-${suffix}`,
  login: driverLogin,
  samsaraPrimaryLogin: `primary-${suffix}`,
  samsaraSecondaryLogin: `secondary-${suffix}`,
  ownYardFixedMinutes: 40,
  vendorFixedMinutes: 35,
  deliveryFixedMinutes: 35,
  minutesPerPallet: 1
};

try {
  await rollback.run(async () => {
    const defaultResult = await replaceDispatchFleetSetup(
      { drivers: [fixture], trucks: [] },
      { activeOnly: false, deactivateMissing: false }
    );
    const defaultDriver = defaultResult.drivers.find((item) => item.login === driverLogin);
    assert.ok(defaultDriver, "Default-off driver fixture was not saved.");
    assert.equal(defaultDriver.samsaraEnabled, false, "A new driver must default to Samsara off.");

    const storedDefault = await query(
      "SELECT samsara_enabled FROM dispatch_drivers WHERE lower(btrim(login)) = $1",
      [driverLogin]
    );
    assert.equal(storedDefault.rows[0]?.samsara_enabled, false, "PostgreSQL did not store the default-off setting.");

    await replaceDispatchFleetSetup(
      {
        drivers: [{
          ...fixture,
          id: defaultDriver.id,
          samsaraEnabled: true
        }],
        trucks: []
      },
      { activeOnly: false, deactivateMissing: false }
    );
    const enabledDriver = await getDispatchDriverByLogin(driverLogin);
    assert.equal(enabledDriver?.samsaraEnabled, true, "The enabled setting did not round-trip through PostgreSQL.");

    const disabledState = await getDriverDayState(driverLogin, {
      samsaraAccounts: {
        enabled: false,
        primaryUsername: fixture.samsaraPrimaryLogin,
        secondaryUsername: fixture.samsaraSecondaryLogin
      }
    });
    assert.equal(disabledState.samsaraEnabled, false);
    assert.equal(disabledState.preDvirRequired, false);
    assert.equal(disabledState.postDvirRequired, false);
    assert.equal(disabledState.preDvirStatus, "complete");
    assert.equal(disabledState.postDvirStatus, "complete");
    assert.equal(disabledState.samsaraOnDutyConfirmed, true);
    assert.equal(disabledState.samsaraOffDutyConfirmed, true);
    assert.equal(disabledState.samsaraPreDvirConfirmed, true);
    assert.equal(disabledState.samsaraPostDvirConfirmed, true);
    assert.deepEqual(disabledState.truckSwitchAttention, []);

    const disabledDuty = await ensureDriverSamsaraDutyForJob(untouchedLogin, {
      samsaraAccounts: {
        enabled: false,
        primaryUsername: `unused-primary-${suffix}`,
        secondaryUsername: `unused-secondary-${suffix}`
      },
      job: {
        truckId: `TRUCK-${suffix}`,
        truckPlate: `TEST-${suffix}`,
        loadId: `LOAD-${suffix}`
      }
    });
    assert.deepEqual(
      disabledDuty,
      { switched: false, reason: "samsara_disabled", account: "" },
      "Disabled account handoff did not stop before assignment/Samsara processing."
    );

    await assert.rejects(
      () => submitDriverDvir(untouchedLogin, {
        type: "pre",
        photoDataUrls: [],
        samsaraAccounts: {
          enabled: false,
          primaryUsername: `unused-primary-${suffix}`,
          secondaryUsername: `unused-secondary-${suffix}`
        }
      }),
      (error) => {
        assert.equal(error?.status, 409);
        assert.equal(error?.code, "DRIVER_SAMSARA_DISABLED");
        return true;
      },
      "Disabled DVIR submission must fail before assignment/Samsara processing."
    );

    const unexpectedSafetyRows = await query(
      "SELECT count(*)::integer AS count FROM driver_day_records WHERE driver_login = $1",
      [untouchedLogin]
    );
    assert.equal(
      unexpectedSafetyRows.rows[0]?.count,
      0,
      "Disabled duty/DVIR safety paths unexpectedly created a driver-day record."
    );
  });

  console.log(JSON.stringify({
    migrationDefaultOff: true,
    setupRoundTrip: true,
    legacySetupSaveProtected: true,
    disabledDvirBypass: true,
    gpsStillEnforced: true,
    disabledAccountHandoffBypass: true
  }));
} finally {
  await rollback.rollback();
  await closeDb();
}
