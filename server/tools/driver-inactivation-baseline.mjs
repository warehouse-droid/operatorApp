import assert from "node:assert/strict";
import { access, cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";

// Reconstruct only this task's pre-change behavior. The shared workspace has
// unrelated edits, so git HEAD is not a valid baseline for these regressions.
const reversals = [
  ["src/dispatch-fleet-status.js", "if (!resolvedDriver)", "if (!resolvedDriver || resolvedDriver.active === false)"],
  ["src/driver-repository.js", 'import { assertDriverExecutionActive } from "./driver-execution-access.js";\n', ""],
  ["src/driver-repository.js", '    await assertDriverExecutionActive(driverLogin, options.job);\n', "", 2],
  ["src/driver-repository.js", `export async function recordDriverJobPhotos(driverLogin, jobIdValue, options = {}) {
  return withTransaction(async () => {
    return recordDriverJobPhotosUnlocked(driverLogin, jobIdValue, options);
  });
}

async function recordDriverJobPhotosUnlocked(driverLogin, jobIdValue, {`,
  "export async function recordDriverJobPhotos(driverLogin, jobIdValue, {"],
  ["src/dispatch-setup-repository.js", 'import { DISPATCH_FLEET_PLANNING_LOCK } from "./dispatch-fleet-status.js";\n', ""],
  ["src/dispatch-setup-repository.js", `export async function setDispatchDriverActive(id, active) {
  const driverId = fleetRecordId(id, "Driver");
  return withTransaction(async () => {
    await query("SELECT pg_advisory_xact_lock(hashtext($1))", [DISPATCH_FLEET_PLANNING_LOCK]);`,
  `export async function setDispatchDriverActive(id, active) {
  const driverId = fleetRecordId(id, "Driver");
  return withTransaction(async () => {`],
  ["src/server.js", `      const result = await setDispatchDriverActive(current.id, req.body.active);
      if (result && !result.driver.active) await revokeDispatchDriverSessions(result.driver.login);
      return { current, result };`,
  `      const conflicts = req.body.active ? [] : await dispatchFleetDisableConflicts({ driver: current });
      if (conflicts.length) return { current, conflicts };
      return { current, result: await setDispatchDriverActive(current.id, req.body.active) };`],
  ["src/server.js", `    const { result } = change;
    if (!result) return res.status(404).json({ error: "Driver not found." });
    await writeDispatchAudit({`,
  `    if (change.conflicts?.length) {
      return res.status(409).json({
        code: "DISPATCH_FLEET_IN_USE",
        error: \`Cannot disable \${change.current.name || change.current.login}. Reassign or finish the active work first. \${change.conflicts[0].message}\`,
        conflicts: change.conflicts
      });
    }
    const { result } = change;
    if (!result) return res.status(404).json({ error: "Driver not found." });
    if (!result.driver.active) await revokeDispatchDriverSessions(result.driver.login);
    await writeDispatchAudit({`],
  ["src/mbt/bin-dispatch-service.js", "      || current.active !== true\n      || current.bin_type_active !== true", "      || current.active !== true\n      || current.driver_active !== true\n      || current.bin_type_active !== true"],
  ["src/mbt/bin-planning-assignments.js", '    && current.truck_active && current.truck_type === "bin" && current.bin_service_enabled;', '    && current.driver_active && current.truck_active && current.truck_type === "bin" && current.bin_service_enabled;'],
  ["public/dispatch-setup.js", "Sign-in and job execution will be blocked immediately. Planning can continue. Unfinished jobs will remain assigned until Dispatch reassigns them to an active driver. Existing history and statistics will remain.", "The driver will be removed from new planning and sign-in. Existing history and statistics will remain. Active work must be reassigned or finished first."]
];

export async function withDriverInactivationBaseline(root, callback) {
  const scratch = await mkdtemp(path.join(root, "test-artifacts", "driver-inactivation-baseline-"));
  try {
    for (const directory of ["src", "public", "contracts", "migrations"]) {
      await cp(path.join(root, directory), path.join(scratch, directory), { recursive: true });
    }
    await copyDriverTestSources(root, scratch);
    await mkdir(path.join(scratch, "tools"));
    for (const file of ["package.json", "tools/driver-inactivation-checks.mjs", "tools/driver-inactivation-baseline.mjs"]) {
      await cp(path.join(root, file), path.join(scratch, file), { recursive: true });
    }
    await symlink(path.join(root, "node_modules"), path.join(scratch, "node_modules"));
    for (const [file, before, after, count = 1] of reversals) {
      const filename = path.join(scratch, file);
      const source = await readFile(filename, "utf8");
      assert.equal(source.split(before).length, count + 1, `Baseline anchor: ${file}`);
      await writeFile(filename, source.replaceAll(before, after));
    }
    return await callback(scratch);
  } finally { await rm(scratch, { recursive: true, force: true }); }
}

// Unrelated retained reports can be owner-only in the runtime image. Copy the
// readable test tree without changing those permissions; missing executable
// inputs still fail the baseline comparison or the pristine mutation control.
export async function copyDriverTestSources(root, scratch) {
  await cp(path.join(root, "test"), path.join(scratch, "test"), {
    recursive: true,
    filter: async source => {
      try { await access(source, constants.R_OK); return true; }
      catch (error) {
        if (error.code === "EACCES") { return false; }
        throw error;
      }
    }
  });
}
