// @ts-check

import { serializeCsv } from "../../../src/mbt/bounded-csv.js";

export const ASSET_CSV_HEADERS = Object.freeze([
  "asset_code",
  "qr_code",
  "barcode",
  "bin_type_code",
  "home_yard_code",
  "tare_weight_kg",
  "condition_code",
  "operational_notes",
  "active",
  "under_maintenance",
  "initial_lifecycle_status",
  "initial_location_kind",
  "initial_location_identity",
  "initial_location_reference",
  "occurred_at"
]);

/** @param {string} suffix */
export function assetCsvRows(suffix = "A") {
  const safeSuffix = suffix.replaceAll(/[^a-zA-Z0-9_-]/gu, "_").toUpperCase();
  return [
    {
      asset_code: `P35CSV-${safeSuffix}-14`,
      qr_code: `P35CSV-QR-${safeSuffix}-14`,
      barcode: `P35CSV-BAR-${safeSuffix}-14`,
      bin_type_code: "14YD",
      home_yard_code: "12441",
      tare_weight_kg: "1450.500",
      condition_code: "",
      operational_notes: `Synthetic opening asset ${safeSuffix} 14`,
      active: "true",
      under_maintenance: "false",
      initial_lifecycle_status: "available",
      initial_location_kind: "yard",
      initial_location_identity: "12441",
      initial_location_reference: "12441",
      occurred_at: "2036-08-03T12:34:56.000Z"
    },
    {
      asset_code: `P35CSV-${safeSuffix}-20`,
      qr_code: "",
      barcode: `P35CSV-BAR-${safeSuffix}-20`,
      bin_type_code: "20YD",
      home_yard_code: "12441",
      tare_weight_kg: "",
      condition_code: "",
      operational_notes: `Synthetic opening asset ${safeSuffix} 20`,
      active: "true",
      under_maintenance: "true",
      initial_lifecycle_status: "maintenance",
      initial_location_kind: "yard",
      initial_location_identity: "12441",
      initial_location_reference: "Opening quarantine",
      occurred_at: "2036-08-03T12:35:56.000Z"
    }
  ];
}

/**
 * @param {object} [options]
 * @param {string} [options.suffix]
 * @param {readonly Record<string, unknown>[]} [options.rows]
 * @param {string} [options.fileName]
 */
export function buildAssetCsvFile({
  suffix = "A",
  rows = assetCsvRows(suffix),
  fileName = "mbt-bin-assets-v1.csv"
} = {}) {
  return {
    fileName,
    content: serializeCsv({ headers: ASSET_CSV_HEADERS, rows, protectFormulae: false })
  };
}

/** @param {string} suffix */
export function expectedParsedAssetRows(suffix = "A") {
  const rows = assetCsvRows(suffix);
  return rows.map((row, index) => ({
    rowNumber: index + 2,
    assetCode: row.asset_code,
    qrCode: row.qr_code || null,
    barcode: row.barcode || null,
    binTypeCode: row.bin_type_code,
    homeYardCode: row.home_yard_code,
    tareWeightKg: row.tare_weight_kg || null,
    conditionCode: row.condition_code || null,
    operationalNotes: row.operational_notes,
    active: row.active === "true",
    underMaintenance: row.under_maintenance === "true",
    initialState: {
      lifecycleStatus: row.initial_lifecycle_status,
      locationKind: row.initial_location_kind,
      locationIdentity: row.initial_location_identity || null,
      locationReference: row.initial_location_reference || null,
      occurredAt: row.occurred_at
    }
  }));
}
