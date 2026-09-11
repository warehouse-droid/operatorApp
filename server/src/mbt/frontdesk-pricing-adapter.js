// @ts-check

import { query } from "../db.js";
import { canonicalSha256, canonicalize } from "./canonical-json.js";
import { MbtError } from "./errors.js";

/** @param {number} status @param {string} code @param {string} message @param {unknown} [cause] */
function failure(status, code, message, cause) {
  return new MbtError({ status, code, message, cause });
}

/** @param {unknown} value */
function text(value) {
  return String(value ?? "").trim();
}

/** @param {unknown[]} values */
function address(values) {
  return values.map(text).filter(Boolean).join(", ");
}

/** @param {Record<string, any>} site */
// eslint-disable-next-line complexity
function siteAddress(site) {
  const nested = site.address && typeof site.address === "object" && !Array.isArray(site.address)
    ? site.address
    : {};
  return text(site.addressText ?? site.address_text ?? site.serviceAddressText)
    || address([
      site.addressLine1 ?? site.address_line_1 ?? nested.addressLine1 ?? nested.address_line_1,
      site.addressLine2 ?? site.address_line_2 ?? nested.addressLine2 ?? nested.address_line_2,
      site.addressLine3 ?? site.address_line_3 ?? nested.addressLine3 ?? nested.address_line_3,
      site.city ?? nested.city,
      site.region ?? site.province ?? nested.region ?? nested.province,
      site.postalCode ?? site.postal_code ?? nested.postalCode ?? nested.postal_code,
      site.countryCode ?? site.country_code ?? nested.countryCode ?? nested.country_code
    ]);
}

/** @param {unknown} value @param {string} label */
function requiredAddress(value, label) {
  const normalized = text(value);
  if (!normalized) {
    throw failure(422, "MBT_FRONTDESK_DISTANCE_ADDRESS_REQUIRED", `${label} is required for distance pricing.`);
  }
  return normalized;
}

/** @param {unknown} value @param {string} label */
function safeNonnegativeInteger(value, label) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) {
    throw failure(422, "MBT_FRONTDESK_DISTANCE_INVALID", `${label} is invalid.`);
  }
  return number;
}

/** @param {Record<string, any>} row */
function yardAddress(row) {
  return address([
    row.address_line_1,
    row.address_line_2,
    row.city,
    row.region,
    row.postal_code,
    row.country_code
  ]);
}

/**
 * @param {{query: Function}} database
 * @param {string} yardCode
 */
async function activeYard(database, yardCode) {
  const selected = await database.query(
    `SELECT yard_id::text, yard_code, display_name,
            address_line_1, address_line_2, city, region, postal_code,
            country_code, latitude::text, longitude::text, revision::text
       FROM mbt_yards
      WHERE yard_code = $1 AND active`,
    [yardCode]
  );
  if (!selected.rowCount) {
    throw failure(422, "MBT_FRONTDESK_ORIGIN_YARD_INVALID", "The selected pricing origin yard is not active.");
  }
  return /** @type {Record<string, any>} */ (selected.rows[0]);
}

/** @param {unknown} value */
function object(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? /** @type {Record<string, any>} */ (value)
    : {};
}

/**
 * Create the one server-owned pricing adapter used by Front Desk and local
 * MBBS previews. The adapter performs a read-only route lookup and returns a
 * bounded immutable snapshot; the Google credential is never retained.
 *
 * @param {{database?: {query: Function}, routeEstimator?: Function}} [dependencies]
 */
export function createFrontdeskPricingAdapter(dependencies = {}) {
  const database = dependencies.database || { query };
  const routeEstimator = dependencies.routeEstimator;

  return Object.freeze({
    /** @param {Record<string, any>} rawInput */
    // eslint-disable-next-line complexity
    async resolveDistance(rawInput = {}) {
      if (typeof routeEstimator !== "function") {
        throw failure(
          503,
          "MBT_FRONTDESK_DISTANCE_UNAVAILABLE",
          "Server distance pricing is not configured. Contact an administrator."
        );
      }
      const input = object(rawInput);
      const explicitOrigin = text(input.originAddressText);
      const yardCode = text(input.originYardCode);
      const yard = explicitOrigin ? null : await activeYard(database, yardCode);
      const originAddress = requiredAddress(explicitOrigin || yardAddress(yard || {}), "Route origin");
      const destinationAddress = requiredAddress(
        input.destinationAddressText
          ?? input.serviceAddressText
          ?? siteAddress(object(input.site)),
        "Service address"
      );
      const originSnapshot = yard
        ? canonicalize({
          kind: "yard",
          yardId: text(yard.yard_id),
          yardCode: text(yard.yard_code),
          displayName: text(yard.display_name),
          addressText: originAddress,
          latitude: yard.latitude === null ? null : Number(yard.latitude),
          longitude: yard.longitude === null ? null : Number(yard.longitude),
          revision: Number(yard.revision)
        })
        : canonicalize({ kind: "address", addressText: originAddress });
      const destinationSnapshot = canonicalize({
        kind: text(input.site?.siteProfileId) ? "customer_site" : "address",
        siteProfileId: text(input.site?.siteProfileId) || null,
        addressText: destinationAddress
      });

      let route;
      try {
        route = object(await routeEstimator({
          subsystem: "frontdesk",
          reason: "frontdesk_distance",
          stops: [{ location: originAddress }, { location: destinationAddress }],
          allowTolls: false,
          automatic: false
        }));
      } catch (error) {
        throw failure(503, "MBT_FRONTDESK_DISTANCE_UNAVAILABLE", "The server could not resolve a driving route.", error);
      }
      if (route.source === "fallback" || !Number.isSafeInteger(Number(route.distanceMeters))) {
        throw failure(422, "MBT_FRONTDESK_ROUTE_NOT_FOUND", "No supported driving route was found for these addresses.");
      }
      const legMetres = (Array.isArray(route.legDistanceMeters) && route.legDistanceMeters.length
        ? route.legDistanceMeters
        : [route.distanceMeters]
      ).map((value, index) => safeNonnegativeInteger(value, `Route leg ${index + 1} distance`));
      const legDurationSeconds = (Array.isArray(route.rawLegMinutes) ? route.rawLegMinutes : [])
        .map((minutes) => Number.isFinite(Number(minutes)) ? Math.max(0, Math.round(Number(minutes) * 60)) : null);
      const providerMetres = legMetres.reduce((sum, value) => {
        const next = sum + value;
        if (!Number.isSafeInteger(next)) {
          throw failure(422, "MBT_FRONTDESK_DISTANCE_INVALID", "The resolved route distance is too large.");
        }
        return next;
      }, 0);
      const routeSnapshot = canonicalize({
        provider: "google_routes_v2",
        mode: "driving",
        avoid: ["tolls"],
        region: "ca",
        legMetres,
        legDurationSeconds
      });
      return {
        provider: "google_routes_v2",
        providerMetres,
        routeHash: canonicalSha256({ originSnapshot, destinationSnapshot, routeSnapshot }),
        originSnapshot,
        destinationSnapshot,
        routeSnapshot
      };
    },

    async resolveTaxPolicy() {
      return { code: "CA-ON-HST", basisPoints: 1_300, label: "Ontario HST 13%" };
    }
  });
}
