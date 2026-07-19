import crypto from "node:crypto";
import { promisify } from "node:util";
import { query, withTransaction } from "./db.js";

const scrypt = promisify(crypto.scrypt);

function numberValue(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function cleanDriver(driver = {}, displayOrder = 0) {
  const login = String(driver.login || "").trim().toLowerCase();
  const name = String(driver.name || "").trim();
  if (!login) throw new Error("Every driver must have a login.");
  if (!name) throw new Error(`Driver ${login} must have a name.`);
  return {
    id: /^\d+$/.test(String(driver.id || "")) ? String(driver.id) : null,
    name,
    license: String(driver.license || "").trim(),
    number: String(driver.number || "").trim(),
    login,
    password: String(driver.password || ""),
    samsaraPrimaryLogin: String(driver.samsaraPrimaryLogin || "").trim(),
    samsaraSecondaryLogin: String(driver.samsaraSecondaryLogin || "").trim(),
    ownYardFixedMinutes: numberValue(driver.ownYardFixedMinutes ?? driver.loadMinutes, 40),
    vendorFixedMinutes: numberValue(driver.vendorFixedMinutes ?? driver.outsideFixedMinutes ?? driver.unloadMinutes, 35),
    deliveryFixedMinutes: numberValue(driver.deliveryFixedMinutes ?? driver.outsideFixedMinutes ?? driver.unloadMinutes, 35),
    minutesPerPallet: numberValue(driver.minutesPerPallet, 1),
    displayOrder
  };
}

function cleanTruck(truck = {}, displayOrder = 0) {
  const plate = String(truck.plate || "").trim().toUpperCase();
  if (!plate) throw new Error("Every truck must have a plate number.");
  return {
    id: /^\d+$/.test(String(truck.id || "")) ? String(truck.id) : null,
    plate,
    capacityLbs: numberValue(truck.capacityLbs, 48000),
    travelTimePercent: numberValue(truck.travelTimePercent, 0),
    baseYard: String(truck.baseYard || truck.base || "").trim(),
    displayOrder
  };
}

function publicDriver(row) {
  if (!row) return null;
  const ownYardFixedMinutes = numberValue(row.own_yard_fixed_minutes, 40);
  const vendorFixedMinutes = numberValue(row.vendor_fixed_minutes, 35);
  const deliveryFixedMinutes = numberValue(row.delivery_fixed_minutes, 35);
  return {
    id: String(row.id),
    name: row.name,
    license: row.license_class,
    number: row.license_number,
    login: row.login,
    password: "",
    passwordConfigured: Boolean(row.password_hash && row.password_salt),
    samsaraPrimaryLogin: row.samsara_primary_login,
    samsaraSecondaryLogin: row.samsara_secondary_login,
    ownYardFixedMinutes,
    vendorFixedMinutes,
    deliveryFixedMinutes,
    outsideFixedMinutes: deliveryFixedMinutes,
    minutesPerPallet: numberValue(row.minutes_per_pallet, 1),
    loadMinutes: ownYardFixedMinutes,
    unloadMinutes: deliveryFixedMinutes
  };
}

function publicTruck(row) {
  if (!row) return null;
  return {
    id: String(row.id),
    plate: row.plate,
    capacityLbs: numberValue(row.capacity_lbs, 48000),
    travelTimePercent: numberValue(row.travel_time_percent, 0),
    baseYard: String(row.base_yard || "").trim()
  };
}

async function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) {
  const derived = await scrypt(String(password), salt, 64);
  return { salt, hash: derived.toString("hex") };
}

async function verifyPassword(password, salt, expectedHash) {
  const { hash } = await hashPassword(password, salt);
  const expected = Buffer.from(expectedHash, "hex");
  const actual = Buffer.from(hash, "hex");
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

function assertUnique(values, label) {
  const seen = new Set();
  for (const value of values) {
    if (seen.has(value)) throw new Error(`Duplicate ${label}: ${value}`);
    seen.add(value);
  }
}

async function driverRows({ activeOnly = true } = {}) {
  const result = await query(
    `SELECT *
     FROM dispatch_drivers
     ${activeOnly ? "WHERE active = true" : ""}
     ORDER BY display_order ASC, id ASC`
  );
  return result.rows;
}

async function truckRows({ activeOnly = true } = {}) {
  const result = await query(
    `SELECT *
     FROM dispatch_trucks
     ${activeOnly ? "WHERE active = true" : ""}
     ORDER BY display_order ASC, id ASC`
  );
  return result.rows;
}

async function upsertDrivers(drivers, { deactivateMissing = true } = {}) {
  const cleaned = drivers.map(cleanDriver);
  assertUnique(cleaned.map((driver) => driver.login), "driver login");
  const existingRows = await driverRows({ activeOnly: false });
  const existingById = new Map(existingRows.map((row) => [String(row.id), row]));
  const existingByLogin = new Map(existingRows.map((row) => [String(row.login).trim().toLowerCase(), row]));
  const keptIds = [];

  for (const driver of cleaned) {
    const existing = (driver.id && existingById.get(driver.id)) || existingByLogin.get(driver.login) || null;
    let passwordHash = existing?.password_hash || null;
    let passwordSalt = existing?.password_salt || null;
    if (driver.password) {
      const password = await hashPassword(driver.password);
      passwordHash = password.hash;
      passwordSalt = password.salt;
    }
    const params = [
      driver.name,
      driver.license,
      driver.number,
      driver.login,
      passwordHash,
      passwordSalt,
      driver.samsaraPrimaryLogin,
      driver.samsaraSecondaryLogin,
      driver.ownYardFixedMinutes,
      driver.vendorFixedMinutes,
      driver.deliveryFixedMinutes,
      driver.minutesPerPallet,
      driver.displayOrder
    ];
    const result = existing
      ? await query(
          `UPDATE dispatch_drivers
           SET name = $1,
               license_class = $2,
               license_number = $3,
               login = $4,
               password_hash = $5,
               password_salt = $6,
               samsara_primary_login = $7,
               samsara_secondary_login = $8,
               own_yard_fixed_minutes = $9,
               vendor_fixed_minutes = $10,
               delivery_fixed_minutes = $11,
               minutes_per_pallet = $12,
               display_order = $13,
               active = true,
               updated_at = now()
           WHERE id = $14
           RETURNING id`,
          [...params, existing.id]
        )
      : await query(
          `INSERT INTO dispatch_drivers (
             name, license_class, license_number, login, password_hash, password_salt,
             samsara_primary_login, samsara_secondary_login, own_yard_fixed_minutes,
             vendor_fixed_minutes, delivery_fixed_minutes, minutes_per_pallet, display_order
           )
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
           RETURNING id`,
          params
        );
    keptIds.push(String(result.rows[0].id));
  }

  if (deactivateMissing) {
    if (keptIds.length) {
      await query(
        `UPDATE dispatch_drivers
         SET active = false, updated_at = now()
         WHERE NOT (id = ANY($1::bigint[]))`,
        [keptIds]
      );
    } else {
      await query("UPDATE dispatch_drivers SET active = false, updated_at = now() WHERE active = true");
    }
  }
}

async function upsertTrucks(trucks, { deactivateMissing = true } = {}) {
  const cleaned = trucks.map(cleanTruck);
  assertUnique(cleaned.map((truck) => truck.plate), "truck plate");
  const existingRows = await truckRows({ activeOnly: false });
  const existingById = new Map(existingRows.map((row) => [String(row.id), row]));
  const existingByPlate = new Map(existingRows.map((row) => [String(row.plate).trim().toUpperCase(), row]));
  const keptIds = [];

  for (const truck of cleaned) {
    const existing = (truck.id && existingById.get(truck.id)) || existingByPlate.get(truck.plate) || null;
    const params = [truck.plate, truck.capacityLbs, truck.travelTimePercent, truck.baseYard, truck.displayOrder];
    const result = existing
      ? await query(
          `UPDATE dispatch_trucks
           SET plate = $1,
               capacity_lbs = $2,
               travel_time_percent = $3,
               base_yard = $4,
               display_order = $5,
               active = true,
               updated_at = now()
           WHERE id = $6
           RETURNING id`,
          [...params, existing.id]
        )
      : await query(
          `INSERT INTO dispatch_trucks (plate, capacity_lbs, travel_time_percent, base_yard, display_order)
           VALUES ($1, $2, $3, $4, $5)
           RETURNING id`,
          params
        );
    keptIds.push(String(result.rows[0].id));
  }

  if (deactivateMissing) {
    if (keptIds.length) {
      await query(
        `UPDATE dispatch_trucks
         SET active = false, updated_at = now()
         WHERE NOT (id = ANY($1::bigint[]))`,
        [keptIds]
      );
    } else {
      await query("UPDATE dispatch_trucks SET active = false, updated_at = now() WHERE active = true");
    }
  }
}

export async function listDispatchDrivers() {
  return (await driverRows()).map(publicDriver);
}

export async function listDispatchTrucks() {
  return (await truckRows()).map(publicTruck);
}

export async function getDispatchDriverByLogin(login) {
  const result = await query(
    `SELECT *
     FROM dispatch_drivers
     WHERE lower(btrim(login)) = $1
       AND active = true
     LIMIT 1`,
    [String(login || "").trim().toLowerCase()]
  );
  return publicDriver(result.rows[0]);
}

export async function authenticateDispatchDriver(login, password) {
  const result = await query(
    `SELECT *
     FROM dispatch_drivers
     WHERE lower(btrim(login)) = $1
       AND active = true
     LIMIT 1`,
    [String(login || "").trim().toLowerCase()]
  );
  const row = result.rows[0];
  if (!row) return { driver: null, reason: "invalid" };
  if (!row.password_hash || !row.password_salt) {
    return String(password || "")
      ? { driver: null, reason: "password_not_configured" }
      : { driver: publicDriver(row), reason: "" };
  }
  const valid = await verifyPassword(String(password || ""), row.password_salt, row.password_hash);
  return valid ? { driver: publicDriver(row), reason: "" } : { driver: null, reason: "invalid" };
}

export async function replaceDispatchFleetSetup({ drivers = [], trucks = [] }) {
  return withTransaction(async () => {
    await upsertDrivers(drivers, { deactivateMissing: true });
    await upsertTrucks(trucks, { deactivateMissing: true });
    return {
      drivers: (await driverRows()).map(publicDriver),
      trucks: (await truckRows()).map(publicTruck)
    };
  });
}

export async function ensureDispatchFleetSetup({ drivers = [], trucks = [] }) {
  return withTransaction(async () => {
    await query("SELECT pg_advisory_xact_lock(hashtext('dispatch_fleet_setup_seed'))");
    const [driverCount, truckCount] = await Promise.all([
      query("SELECT count(*)::integer AS count FROM dispatch_drivers WHERE active = true"),
      query("SELECT count(*)::integer AS count FROM dispatch_trucks WHERE active = true")
    ]);
    if (!driverCount.rows[0].count && drivers.length) await upsertDrivers(drivers, { deactivateMissing: false });
    if (!truckCount.rows[0].count && trucks.length) await upsertTrucks(trucks, { deactivateMissing: false });
    return {
      drivers: (await driverRows()).map(publicDriver),
      trucks: (await truckRows()).map(publicTruck)
    };
  });
}
