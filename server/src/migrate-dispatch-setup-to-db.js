import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { closeDb } from "./db.js";
import { replaceDispatchFleetSetup } from "./dispatch-setup-repository.js";

const dirname = path.dirname(fileURLToPath(import.meta.url));
const setupPath = path.resolve(dirname, "../data/dispatch-setup.json");

try {
  const text = await fs.readFile(setupPath, "utf8");
  const setup = JSON.parse(text);
  const drivers = Array.isArray(setup.drivers) ? setup.drivers : [];
  const trucks = Array.isArray(setup.trucks) ? setup.trucks : [];
  if (!drivers.length && !trucks.length) {
    throw new Error("dispatch-setup.json does not contain any driver or truck records to import.");
  }

  const fleet = await replaceDispatchFleetSetup({ drivers, trucks });
  const configOnly = { ...setup };
  delete configOnly.drivers;
  delete configOnly.trucks;
  await fs.writeFile(setupPath, `${JSON.stringify(configOnly, null, 2)}\n`);
  console.log(`Imported ${fleet.drivers.length} drivers and ${fleet.trucks.length} trucks into PostgreSQL.`);
  console.log("Removed plaintext fleet credentials from dispatch-setup.json after the successful import.");
} finally {
  await closeDb();
}
