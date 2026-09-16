import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const artifact = path.resolve("test-artifacts/split-address");
const stage = mkdtempSync("/tmp/dispatch-split-address-mutants-");
const unit = "test/dispatch/unit/dispatch-split-address.test.js";
const integration = "test/dispatch/integration/dispatch-split-address.test.js";
const http = "test/dispatch/integration/dispatch-split-address-http.test.js";
const groupFile = "src/dispatch-delivery-group-repository.js";
const mutants = [
  ["refresh-erases-override", groupFile, "applyActiveTransitCoMetadata(applySplitDispatchDetails(next), activeBySource)", "applyActiveTransitCoMetadata(next, activeBySource)", integration],
  ["empty-address-inherits", groupFile, 'if (Object.hasOwn(details, "address"))', 'if (details.address)', unit],
  ["stale-destination-alias", groupFile, "next.destinationAddress = next.address;", "next.destinationAddress = order.destinationAddress;", unit],
  ["card-drops-override", "src/dispatch-planner-optimization.js", '"pickupAddressOverride", "dispatchDetailsOverride",', '"pickupAddressOverride",', unit],
  ["stale-confirmation-address", "src/delivery-repository.js", "const details = savedDetails || order.dispatchDetailsOverride || {};", "const details = order.dispatchDetailsOverride || {};", integration],
  ["edit-races-plan-save", groupFile, 'await query("SELECT pg_advisory_xact_lock(hashtext($1))", [DISPATCH_FLEET_PLANNING_LOCK]);', "/* mutant: no fleet lock */", http],
  ["browser-drops-acknowledged-override", "public/dispatch.js", "order.dispatchDetailsOverride = payload.updated.dispatch_details_override;",
    "order.dispatchDetailsOverride = {};", "test/dispatch/frontend/dispatch-split-address.test.js"]
];
const results = [];
try {
  for (const dir of ["src", "public", "test", "tools"]) {cpSync(dir, path.join(stage, dir), { recursive: true });}
  for (const entry of ["node_modules", "package.json", "migrations"]) {symlinkSync(path.resolve(entry), path.join(stage, entry));}
  for (const [name, file, before, after, testFile] of mutants) {
    const target = path.join(stage, file);
    const original = readFileSync(target, "utf8");
    assert.equal(original.split(before).length, 2, `${name}: mutation must have exactly one target`);
    writeFileSync(target, original.replace(before, after));
    try {
      const full = spawnSync(process.execPath, ["tools/dispatch-split-address-files.mjs", testFile], { cwd: stage, encoding: "utf8", maxBuffer: 12e6 });
      writeFileSync(path.join(artifact, `mutant-${name}.log`), `${full.stdout}${full.stderr}`);
      assert.equal(full.status, 1, `${name} must fail an assertion in its regression suite`);
      assert.match(`${full.stdout}${full.stderr}`, /ERR_ASSERTION|AssertionError/u, `${name} must not die from test setup failure`);
      const property = spawnSync(process.execPath, ["--test", "--test-name-pattern=^explicit details", unit], { cwd: stage, encoding: "utf8", maxBuffer: 4e6 });
      writeFileSync(path.join(artifact, `mutant-property-${name}.log`), `${property.stdout}${property.stderr}`);
      assert.ok(property.status === 0 || property.status === 1);
      results.push({ name, killed: true, propertyKilled: property.status === 1 });
    } finally { writeFileSync(target, original); }
  }
} finally { rmSync(stage, { recursive: true, force: true }); }
writeFileSync(path.join(artifact, "mutations.json"), JSON.stringify(results, null, 2));
console.log(JSON.stringify(results));
