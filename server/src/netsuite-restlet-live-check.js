import { closeDb } from "./db.js";
import { probeNetSuiteRestlet } from "./netsuite.js";

function optionValue(name) {
  const prefix = `${name}=`;
  const direct = process.argv.slice(2).find((argument) => argument.startsWith(prefix));
  if (direct) return direct.slice(prefix.length);
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}

const entityId = optionValue("--entity-id");
const locationId = optionValue("--location");
const allowProduction = process.argv.includes("--allow-production");

try {
  if (locationId && !entityId) throw new Error("--location requires --entity-id.");
  const result = await probeNetSuiteRestlet({
    entityId,
    locationId,
    requireSandbox: !allowProduction
  });
  console.log(JSON.stringify({
    ok: result.ok,
    action: result.action,
    version: result.version,
    environment: result.environment,
    sandbox: result.sandbox,
    accountId: result.accountId,
    entityId: result.entityId ?? null,
    locationId: result.locationId ?? null,
    locationApplied: result.locationApplied ?? null,
    filename: result.filename ?? null,
    contentIncluded: result.contentIncluded ?? null,
    fileSize: result.fileSize ?? null,
    remainingUsage: result.remainingUsage ?? null
  }, null, 2));
} catch (caught) {
  console.error(`NetSuite RESTlet live check failed: ${caught.message}`);
  process.exitCode = 1;
} finally {
  await closeDb();
}
