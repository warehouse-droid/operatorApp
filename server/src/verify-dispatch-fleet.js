import { beginRollbackContext, closeDb, query } from "./db.js";
import { listDispatchDrivers, listDispatchTrucks, replaceDispatchFleetSetup } from "./dispatch-setup-repository.js";

const passwordFingerprints = async () => (await query(
  `SELECT md5(coalesce(password_hash, '') || ':' || coalesce(password_salt, '')) AS fingerprint
   FROM dispatch_drivers
   WHERE active = true
   ORDER BY id`
)).rows.map((row) => row.fingerprint);

const before = await passwordFingerprints();
const rollbackContext = await beginRollbackContext();

try {
  const result = await rollbackContext.run(async () => {
    const drivers = await listDispatchDrivers();
    const trucks = await listDispatchTrucks();
    await replaceDispatchFleetSetup({ drivers, trucks });
    const after = await passwordFingerprints();
    if (JSON.stringify(before) !== JSON.stringify(after)) {
      throw new Error("Driver password hashes changed during a blank-password setup save.");
    }
    return { drivers: drivers.length, trucks: trucks.length, passwordHashesPreserved: true };
  });
  console.log(JSON.stringify(result));
} finally {
  await rollbackContext.rollback();
  await closeDb();
}
