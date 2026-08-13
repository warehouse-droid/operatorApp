import { DRIVER_OFFLINE_STRESS_CASES, validateStressMatrix } from "./driver-offline-stress-matrix.mjs";

const result = validateStressMatrix();
if (!result.valid) {throw new Error(result.errors.join("\n"));}
console.log(JSON.stringify({
  cases: DRIVER_OFFLINE_STRESS_CASES.length,
  smoke: DRIVER_OFFLINE_STRESS_CASES.filter(({ smoke }) => smoke).length,
  browser: DRIVER_OFFLINE_STRESS_CASES.filter(({ runtime }) => runtime === "browser").length,
  nodePostgresql: DRIVER_OFFLINE_STRESS_CASES.filter(({ runtime }) => runtime === "node-postgresql").length,
  projects: result.projectCounts
}, null, 2));
