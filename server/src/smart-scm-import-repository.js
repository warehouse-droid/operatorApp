import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import ExcelJS from "exceljs";
import { config } from "./config.js";
import { query, withTransaction } from "./db.js";
import { writeAudit } from "./auth-repository.js";

export const SMART_SCM_INPUT_SLOTS = Object.freeze({
  item_master: { label: "Item Master", extensions: [".xlsx"] },
  sales_data: { label: "Sales Data", extensions: [".xlsx"] },
  decision_workbook: { label: "TO/PO Decision Workbook", extensions: [".xlsx"] },
  decision_tree: { label: "Decision Tree", extensions: [".docx"] },
  decision_script: { label: "Decision Script", extensions: [".js"] }
});

const YARDS = Object.freeze([
  { code: "3445", locationId: 1, itemColumn: "3445", serviceQuantile: 0.90, minimumSafetyPallets: 2 },
  { code: "2967", locationId: 28, itemColumn: "2967", serviceQuantile: 0.90, minimumSafetyPallets: 1 },
  { code: "12441", locationId: 15, itemColumn: "12441", serviceQuantile: 0.95, minimumSafetyPallets: 1 },
  { code: "150", locationId: 26, itemColumn: "150", serviceQuantile: 0.90, minimumSafetyPallets: 2 }
]);

function cleanText(value) {
  return String(value ?? "").replaceAll("\u00a0", " ").trim();
}

function cleanNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(String(value).replaceAll(",", "").replaceAll("%", ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function cleanBoolean(value) {
  return /^(1|true|yes|y|inactive|discon|discontinued)$/i.test(cleanText(value));
}

function normalizeHeader(value) {
  return cleanText(value).toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function excelCellValue(cell) {
  let value = cell?.value;
  if (value && typeof value === "object") {
    if (Object.hasOwn(value, "result")) value = value.result;
    else if (Array.isArray(value.richText)) value = value.richText.map((part) => part.text || "").join("");
    else if (Object.hasOwn(value, "text")) value = value.text;
    else if (Object.hasOwn(value, "hyperlink")) value = value.text || value.hyperlink;
  }
  return value;
}

function excelDate(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString().slice(0, 10);
  const number = cleanNumber(value);
  if (number !== null && number > 1000) {
    const date = new Date(Date.UTC(1899, 11, 30) + (number * 86400000));
    if (!Number.isNaN(date.getTime())) return date.toISOString().slice(0, 10);
  }
  const text = cleanText(value);
  if (!text) return null;
  const date = new Date(text);
  return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10);
}

function safeOriginalFilename(filename) {
  const base = path.basename(cleanText(filename) || "upload.bin");
  return base.replace(/[^a-zA-Z0-9._() -]+/g, "_").slice(0, 180) || "upload.bin";
}

function inputSlot(slot) {
  const key = cleanText(slot).toLowerCase();
  const definition = SMART_SCM_INPUT_SLOTS[key];
  if (!definition) throw Object.assign(new Error("Invalid Smart SCM input slot."), { status: 400 });
  return { key, definition };
}

function assertFileExtension(slot, filename) {
  const extension = path.extname(filename).toLowerCase();
  if (!slot.definition.extensions.includes(extension)) {
    throw Object.assign(new Error(`${slot.definition.label} requires ${slot.definition.extensions.join(" or ")}.`), { status: 400 });
  }
}

function workbookSheet(workbook, name) {
  return workbook.worksheets.find((sheet) => cleanText(sheet.name).toLowerCase() === cleanText(name).toLowerCase()) || null;
}

function headerMap(sheet, rowNumber = 1) {
  const map = new Map();
  const row = sheet.getRow(rowNumber);
  row.eachCell({ includeEmpty: false }, (cell, columnNumber) => {
    const normalized = normalizeHeader(excelCellValue(cell));
    if (normalized && !map.has(normalized)) map.set(normalized, columnNumber);
  });
  return map;
}

function requiredColumn(headers, candidates, label) {
  for (const candidate of candidates) {
    const found = headers.get(normalizeHeader(candidate));
    if (found) return found;
  }
  throw new Error(`Required column ${label} was not found.`);
}

function optionalColumn(headers, candidates) {
  for (const candidate of candidates) {
    const found = headers.get(normalizeHeader(candidate));
    if (found) return found;
  }
  return null;
}

function rowValue(row, column) {
  return row && column ? excelCellValue(row.getCell(column)) : null;
}

function chunks(values, size = 200) {
  const result = [];
  for (let index = 0; index < values.length; index += size) result.push(values.slice(index, index + size));
  return result;
}

async function bulkStatement({ rows, columns, prefix, suffix = "", chunkSize = 200 }) {
  for (const group of chunks(rows, chunkSize)) {
    const params = [];
    const values = group.map((row) => {
      const placeholders = columns.map((column) => {
        params.push(row[column]);
        return `$${params.length}`;
      });
      return `(${placeholders.join(", ")})`;
    });
    await query(`${prefix} VALUES ${values.join(", ")} ${suffix}`, params);
  }
}

async function readWorkbook(storagePath) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(storagePath);
  return workbook;
}

function parseItemMaster(workbook) {
  const sheet = workbookSheet(workbook, "ItemMaster");
  if (!sheet) throw new Error("ItemMaster sheet was not found.");
  const headers = headerMap(sheet);
  const columns = {
    itemId: requiredColumn(headers, ["Internal ID", "ID"], "Internal ID"),
    name: requiredColumn(headers, ["Name", "Item"], "Name"),
    description: optionalColumn(headers, ["Desc", "Description"]),
    vendor: optionalColumn(headers, ["Vendor"]),
    series: optionalColumn(headers, ["Series"]),
    stockUnit: optionalColumn(headers, ["Primary Stock Unit", "Stock Unit"]),
    toPlt: optionalColumn(headers, ["ToPLT"]),
    toLyr: optionalColumn(headers, ["ToLYR"]),
    toPcs: optionalColumn(headers, ["ToPCS"]),
    toSec: optionalColumn(headers, ["ToSEC"]),
    leadTime: optionalColumn(headers, ["Est Lead Time(Day)", "Estimated Lead Time Days", "Lead Time Days"]),
    plant: optionalColumn(headers, ["Plant", "Plant Location"]),
    weight: optionalColumn(headers, ["Weight per Pallet", "Pallet Weight"]),
    turnover: optionalColumn(headers, ["Inventory Turnover"]),
    soh: optionalColumn(headers, ["Average SOH Day"]),
    velocityClass: optionalColumn(headers, ["Class"]),
    purchaseLead: optionalColumn(headers, ["Purchase Lead Time"]),
    safetyLevel: optionalColumn(headers, ["Safety Stock Level"]),
    safetyDays: optionalColumn(headers, ["Safety Stock Days"]),
    seasonal: optionalColumn(headers, ["Seasonal Demand"]),
    expectedChange: optionalColumn(headers, ["Expected Demand Change"]),
    vendorCode: optionalColumn(headers, ["Vendor Code"]),
    inactive: optionalColumn(headers, ["Inactive"]),
    discontinued: optionalColumn(headers, ["Discon", "Discontinued"]),
    yardEligibility: Object.fromEntries(YARDS.map((yard) => [yard.code, optionalColumn(headers, [yard.itemColumn])]))
  };
  const itemById = new Map();
  const yardPoliciesByKey = new Map();
  let sourceRows = 0;
  let duplicateRows = 0;
  const completeness = (item) => Object.values(item).filter((value) => value !== null && value !== undefined && value !== "").length;
  sheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    if (rowNumber === 1) return;
    const itemId = cleanNumber(rowValue(row, columns.itemId));
    const itemName = cleanText(rowValue(row, columns.name));
    if (!Number.isInteger(itemId) || itemId <= 0 || !itemName) return;
    sourceRows += 1;
    const vendorYard = cleanText(rowValue(row, columns.plant)) || null;
    const item = {
      item_id: itemId,
      item_name: itemName,
      item_description: cleanText(rowValue(row, columns.description)) || null,
      vendor: cleanText(rowValue(row, columns.vendor)) || null,
      vendor_code: cleanText(rowValue(row, columns.vendorCode)) || null,
      series: cleanText(rowValue(row, columns.series)) || null,
      stock_unit: cleanText(rowValue(row, columns.stockUnit)) || null,
      to_plt: cleanNumber(rowValue(row, columns.toPlt)),
      to_lyr: cleanNumber(rowValue(row, columns.toLyr)),
      to_sec: cleanNumber(rowValue(row, columns.toSec)),
      to_pcs: cleanNumber(rowValue(row, columns.toPcs)),
      lead_time_days: cleanNumber(rowValue(row, columns.leadTime)),
      plant: vendorYard,
      vendor_yard: vendorYard,
      pallet_weight_lbs: cleanNumber(rowValue(row, columns.weight)),
      inventory_turnover: cleanNumber(rowValue(row, columns.turnover)),
      average_soh_days: cleanNumber(rowValue(row, columns.soh)),
      velocity_class: cleanText(rowValue(row, columns.velocityClass)) || null,
      purchase_lead_time_days: cleanNumber(rowValue(row, columns.purchaseLead)),
      safety_stock_level: cleanNumber(rowValue(row, columns.safetyLevel)),
      safety_stock_days: cleanNumber(rowValue(row, columns.safetyDays)),
      seasonal_demand: cleanText(rowValue(row, columns.seasonal)) || null,
      expected_demand_change: cleanNumber(rowValue(row, columns.expectedChange)),
      inactive: cleanBoolean(rowValue(row, columns.inactive)),
      discontinued: cleanBoolean(rowValue(row, columns.discontinued))
    };
    const current = itemById.get(itemId);
    if (current) duplicateRows += 1;
    // A few operational workbooks repeat an internal ID. Prefer the most
    // complete record; when completeness is equal, the later row wins.
    if (current && completeness(current) > completeness(item)) return;
    itemById.set(itemId, item);
    for (const yard of YARDS) {
      const raw = rowValue(row, columns.yardEligibility[yard.code]);
      const eligible = /^(yes|y|true|1)$/i.test(cleanText(raw));
      yardPoliciesByKey.set(`${itemId}:${yard.locationId}`, {
        item_id: itemId,
        location_id: yard.locationId,
        yard_code: yard.code,
        eligible,
        capacity_pallets: eligible ? 25 : null,
        service_quantile: yard.serviceQuantile,
        minimum_safety_pallets: yard.minimumSafetyPallets
      });
    }
  });
  const items = [...itemById.values()];
  const yardPolicies = [...yardPoliciesByKey.values()];
  if (!items.length) throw new Error("ItemMaster has no valid item rows.");
  return { items, yardPolicies, summary: { items: items.length, yardPolicies: yardPolicies.length, sourceRows, duplicateRows } };
}

function canonicalYard(value) {
  const text = cleanText(value).replace(/\.0$/, "");
  const locationIdMap = new Map([["1", "3445"], ["28", "2967"], ["15", "12441"], ["26", "150"]]);
  const directCode = locationIdMap.get(text) || text;
  return YARDS.find((yard) => yard.code === directCode)
    || YARDS.find((yard) => new RegExp(`(^|[^0-9])${yard.code}([^0-9]|$)`).test(text))
    || null;
}

function parseSalesSheet(sheet, sourceFileId) {
  const headers = headerMap(sheet);
  const columns = {
    itemId: requiredColumn(headers, ["Internal ID", "Item Internal ID"], "Internal ID"),
    date: requiredColumn(headers, ["Date"], "Date"),
    document: requiredColumn(headers, ["Document Number"], "Document Number"),
    itemName: requiredColumn(headers, ["Item", "Name"], "Item"),
    quantity: requiredColumn(headers, ["Quantity"], "Quantity"),
    method: requiredColumn(headers, ["Delivery Method"], "Delivery Method"),
    location: requiredColumn(headers, ["Location"], "Location"),
    salesAmount: optionalColumn(headers, ["Sales Amount"])
  };
  const occurrences = new Map();
  const facts = [];
  sheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    if (rowNumber === 1) return;
    const itemId = cleanNumber(rowValue(row, columns.itemId));
    const transactionDate = excelDate(rowValue(row, columns.date));
    const quantity = cleanNumber(rowValue(row, columns.quantity));
    const yard = canonicalYard(rowValue(row, columns.location));
    if (!Number.isInteger(itemId) || itemId <= 0 || !transactionDate || !yard || quantity === null || quantity <= 0) return;
    const documentRef = cleanText(rowValue(row, columns.document));
    const method = cleanText(rowValue(row, columns.method));
    const itemName = cleanText(rowValue(row, columns.itemName));
    const identity = [sheet.name, transactionDate, documentRef, itemId, quantity, method, yard.code].join("|");
    const occurrence = (occurrences.get(identity) || 0) + 1;
    occurrences.set(identity, occurrence);
    facts.push({
      source: "workbook",
      source_key: `workbook:${crypto.createHash("sha256").update(`${identity}|${occurrence}`).digest("hex")}`,
      transaction_date: transactionDate,
      document_ref: documentRef || null,
      item_id: itemId,
      item_name: itemName || null,
      quantity,
      delivery_method: method || null,
      location_id: yard.locationId,
      yard_code: yard.code,
      sales_amount: cleanNumber(rowValue(row, columns.salesAmount)),
      source_input_file_id: sourceFileId
    });
  });
  return facts;
}

function parseSalesData(workbook, sourceFileId) {
  const sheets = ["2025", "2026"].map((name) => workbookSheet(workbook, name)).filter(Boolean);
  if (!sheets.length) throw new Error("Neither the 2025 nor 2026 sales sheet was found.");
  const facts = sheets.flatMap((sheet) => parseSalesSheet(sheet, sourceFileId));
  if (!facts.length) throw new Error("Sales workbook has no valid positive-quantity yard sales rows.");
  const years = [...new Set(facts.map((fact) => fact.transaction_date.slice(0, 4)))].sort();
  return { facts, summary: { facts: facts.length, years } };
}
const DECISION_CAPACITY_YARDS = Object.freeze([
  { code: "3445", locationId: 1, sheet: "3445_Cal", eligibilityColumn: 18, salesAverageColumn: 6, salesSdColumn: 7, minimumOrderColumn: 8, inventoryColumns: [18, 19, 20], safetyFactor: 1.3, minimumSafety: 2 },
  { code: "2967", locationId: 28, sheet: "2967_Cal", eligibilityColumn: 16, salesAverageColumn: 5, salesSdColumn: 11, minimumOrderColumn: 8, inventoryColumns: [14, 15, 16], safetyFactor: 1.3, minimumSafety: 1 },
  { code: "12441", locationId: 15, sheet: "12441_Cal", eligibilityColumn: 17, salesAverageColumn: 3, salesSdColumn: 10, minimumOrderColumn: 9, inventoryColumns: [6, 7, 8], safetyFactor: 1.675, minimumSafety: 1 },
  { code: "150", locationId: 26, sheet: "150_Cal", eligibilityColumn: 19, salesAverageColumn: 4, salesSdColumn: 12, minimumOrderColumn: 8, inventoryColumns: [10, 11, 12], safetyFactor: 1.3, minimumSafety: 2 }
]);

function decisionSignatureValue(value) {
  if (value === null || !Number.isFinite(Number(value))) return null;
  return Math.round(Number(value) * 100000) / 100000;
}

function decisionSignature(values = []) {
  if (values.some((value) => value === null || !Number.isFinite(Number(value)))) return null;
  return values.map(decisionSignatureValue).join("|");
}

function decisionSheetRowsByItem(sheet) {
  const rows = new Map();
  if (!sheet) return rows;
  sheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    if (rowNumber === 1) return;
    const itemId = cleanNumber(rowValue(row, 1));
    // The calculation sheets use VLOOKUP with an exact match, which returns
    // the first source row when the workbook contains a duplicate item ID.
    if (Number.isInteger(itemId) && itemId > 0 && !rows.has(itemId)) rows.set(itemId, row);
  });
  return rows;
}

export function matchSmartScmDecisionCapacityRows({ yard, candidates = [], calculationRows = [] } = {}) {
  const orderedCandidates = candidates.filter((candidate) => candidate?.signature);
  const orderedRows = calculationRows.filter((row) => row?.hasEvidence);
  const candidateCounts = new Map();
  const rowCounts = new Map();
  for (const candidate of orderedCandidates) {
    candidateCounts.set(candidate.signature, Number(candidateCounts.get(candidate.signature) || 0) + 1);
  }
  for (const row of orderedRows) {
    if (row.signature) rowCounts.set(row.signature, Number(rowCounts.get(row.signature) || 0) + 1);
  }
  const usedCandidates = new Set();
  const usedRows = new Set();
  const capacities = [];
  const provenance = [];
  const mappedByMethod = {};

  const recordMatch = (row, candidate, matchMethod) => {
    usedRows.add(row.sourceRow);
    usedCandidates.add(candidate.itemId);
    const invalidCapacity = row.capacity !== null && row.capacity < 0;
    const mappingStatus = invalidCapacity
      ? "unresolved_invalid_capacity"
      : row.capacity === null
        ? "default_missing_capacity"
        : "matched";
    provenance.push({
      yardCode: yard.code,
      locationId: yard.locationId,
      sheetName: yard.sheet,
      sourceRow: row.sourceRow,
      itemId: candidate.itemId,
      capacityPallets: invalidCapacity ? null : row.capacity,
      mappingStatus,
      matchMethod,
      signature: row.signature,
      candidateItemIds: [candidate.itemId],
      details: {
        candidateSourceRow: candidate.sourceRow,
        candidateSignatureValues: candidate.signatureValues,
        signatureValues: row.signatureValues,
        derivedSignatureColumns: row.derivedSignatureColumns || [],
        rawCapacity: row.capacity
      }
    });
    if (mappingStatus !== "matched") return;
    capacities.push({
      item_id: candidate.itemId,
      location_id: yard.locationId,
      yard_code: yard.code,
      capacity_pallets: row.capacity,
      source_sheet: yard.sheet,
      source_row: row.sourceRow,
      match_method: matchMethod
    });
    mappedByMethod[matchMethod] = Number(mappedByMethod[matchMethod] || 0) + 1;
  };

  const recordUnresolved = (row, mappingStatus, candidateItemIds = []) => {
    usedRows.add(row.sourceRow);
    const invalidCapacity = row.capacity !== null && row.capacity < 0;
    provenance.push({
      yardCode: yard.code,
      locationId: yard.locationId,
      sheetName: yard.sheet,
      sourceRow: row.sourceRow,
      itemId: null,
      capacityPallets: invalidCapacity ? null : row.capacity,
      mappingStatus: row.capacity === null && mappingStatus.startsWith("unresolved_")
        ? "default_unresolved_identity"
        : mappingStatus,
      matchMethod: null,
      signature: row.signature,
      candidateItemIds,
      details: {
        signatureValues: row.signatureValues,
        derivedSignatureColumns: row.derivedSignatureColumns || [],
        rawCapacity: row.capacity
      }
    });
  };

  // Prefer the workbook's natural item order only when the signature uniquely
  // identifies both sides. A repeated signature cannot verify an identity by
  // itself, even when the ordinal happens to line up.
  const directCount = Math.min(orderedCandidates.length, orderedRows.length);
  for (let index = 0; index < directCount; index += 1) {
    const candidate = orderedCandidates[index];
    const row = orderedRows[index];
    if (row.signature
      && row.signature === candidate.signature
      && candidateCounts.get(candidate.signature) === 1
      && rowCounts.get(row.signature) === 1) {
      recordMatch(row, candidate, "ordered_verified");
    }
  }

  const candidatesBySignature = new Map();
  for (const candidate of orderedCandidates) {
    if (usedCandidates.has(candidate.itemId)) continue;
    if (!candidatesBySignature.has(candidate.signature)) candidatesBySignature.set(candidate.signature, []);
    candidatesBySignature.get(candidate.signature).push(candidate);
  }
  const rowsBySignature = new Map();
  for (const row of orderedRows) {
    if (usedRows.has(row.sourceRow) || !row.signature) continue;
    if (!rowsBySignature.has(row.signature)) rowsBySignature.set(row.signature, []);
    rowsBySignature.get(row.signature).push(row);
  }

  // A repeated signature only resolves safely when all corresponding rows
  // carry the same capacity. Pairing differing capacities by ordinal would be
  // a guess because the calculation sheets contain no item identity columns.
  for (const [signature, rows] of rowsBySignature) {
    const signatureCandidates = candidatesBySignature.get(signature) || [];
    const sameCapacity = new Set(rows.map((row) => row.capacity === null ? "null" : String(row.capacity))).size === 1;
    if (signatureCandidates.length > 0
      && signatureCandidates.length === rows.length
      && (signatureCandidates.length === 1 || sameCapacity)) {
      rows.forEach((row, index) => recordMatch(
        row,
        signatureCandidates[index],
        signatureCandidates.length === 1 ? "signature_unique" : "signature_same_capacity"
      ));
      continue;
    }
    const candidateIds = signatureCandidates.map((candidate) => candidate.itemId);
    const status = signatureCandidates.length ? "unresolved_cardinality" : "unresolved_no_candidate";
    rows.forEach((row) => recordUnresolved(row, status, candidateIds));
  }

  // Some shared Excel formulas have no cached result even though enough other
  // calculated fields remain to identify the item. Accept a partial signature
  // only when at least three fields agree and exactly one unused candidate
  // matches every available value.
  for (const row of orderedRows) {
    if (usedRows.has(row.sourceRow) || row.signature) continue;
    const evidenceCount = (row.signatureValues || []).filter((value) => value !== null).length;
    if (evidenceCount < 3) continue;
    const candidateMatches = orderedCandidates.filter((candidate) => {
      if (usedCandidates.has(candidate.itemId) || !Array.isArray(candidate.signatureValues)) return false;
      return row.signatureValues.every((value, index) =>
        value === null || decisionSignatureValue(value) === decisionSignatureValue(candidate.signatureValues[index])
      );
    });
    if (candidateMatches.length === 1) {
      recordMatch(row, candidateMatches[0], "partial_signature_unique");
    } else if (candidateMatches.length > 1) {
      recordUnresolved(row, "unresolved_partial_cardinality", candidateMatches.map((candidate) => candidate.itemId));
    } else {
      recordUnresolved(row, "unresolved_no_candidate");
    }
  }

  for (const row of orderedRows) {
    if (usedRows.has(row.sourceRow)) continue;
    recordUnresolved(row, row.signature ? "unresolved_no_candidate" : "unresolved_no_signature");
  }

  const unresolvedCapacityRows = provenance.filter((row) =>
    row.details?.rawCapacity !== null && row.mappingStatus !== "matched"
  ).length;
  return {
    capacities,
    provenance,
    summary: {
      calculationRows: orderedRows.length,
      capacityRows: orderedRows.filter((row) => row.capacity !== null).length,
      mapped: capacities.length,
      mappedZero: capacities.filter((row) => row.capacity_pallets === 0).length,
      mappedByMethod,
      defaultRows: provenance.filter((row) => row.mappingStatus.startsWith("default_")).length,
      unresolvedCapacityRows,
      ambiguous: provenance.filter((row) => ["unresolved_cardinality", "unresolved_partial_cardinality"].includes(row.mappingStatus)).length,
      unmatched: provenance.filter((row) => ["unresolved_no_candidate", "unresolved_no_signature"].includes(row.mappingStatus)).length,
      unmatchedCandidates: orderedCandidates.filter((candidate) => !usedCandidates.has(candidate.itemId)).length
    }
  };
}

export function parseSmartScmDecisionCapacities(workbook) {
  const itemSheet = workbookSheet(workbook, "ItemMaster");
  const salesSheet = workbookSheet(workbook, "2026SalesData");
  const inventorySheet = workbookSheet(workbook, "CurrentInventory");
  if (!itemSheet || !salesSheet || !inventorySheet) {
    return {
      capacities: [], provenance: [], mapped: 0, mappedZero: 0, ambiguous: 0, unmatched: 0,
      unresolved: 0, defaultRows: 0, mappedByMethod: {}, yardSummaries: [],
      warning: "Capacity source sheets were not found."
    };
  }
  const salesByItem = decisionSheetRowsByItem(salesSheet);
  const inventoryByItem = decisionSheetRowsByItem(inventorySheet);
  const itemById = new Map();
  itemSheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    if (rowNumber === 1) return;
    const itemId = cleanNumber(rowValue(row, 1));
    const toPlt = cleanNumber(rowValue(row, 8));
    const leadTimeDays = cleanNumber(rowValue(row, 12));
    if (!Number.isInteger(itemId) || itemId <= 0 || !(toPlt > 0) || !(leadTimeDays > 0)) return;
    // Match the first row because the *_Cal formulas resolve ItemMaster data
    // with exact-match VLOOKUP semantics.
    if (!itemById.has(itemId)) {
      itemById.set(itemId, { itemId, toPlt, leadTimeDays, row, sourceRow: rowNumber });
    }
  });
  const items = [...itemById.values()].sort((left, right) => left.sourceRow - right.sourceRow);
  const capacities = [];
  const provenance = [];
  const summaries = [];
  const missingSheets = [];
  for (const yard of DECISION_CAPACITY_YARDS) {
    const candidates = [];
    for (const item of items) {
      if (!/^(yes|y|true|1)$/i.test(cleanText(rowValue(item.row, yard.eligibilityColumn)))) continue;
      const sales = salesByItem.get(item.itemId);
      const inventory = inventoryByItem.get(item.itemId);
      const averageSales = cleanNumber(rowValue(sales, yard.salesAverageColumn));
      const salesSd = cleanNumber(rowValue(sales, yard.salesSdColumn));
      const minimumOrderSales = cleanNumber(rowValue(sales, yard.minimumOrderColumn));
      const leadWeeks = item.leadTimeDays / 7;
      const weeklyDemand = (averageSales === null ? 0.00001 : averageSales) / item.toPlt;
      const safety = Math.max(((salesSd === null ? 0 : salesSd) / item.toPlt) * yard.safetyFactor * Math.sqrt(leadWeeks), yard.minimumSafety);
      const reorderPoint = Math.max(Math.round(safety + (weeklyDemand * leadWeeks)), 1);
      const available = cleanNumber(rowValue(inventory, yard.inventoryColumns[0])) || 0;
      const onOrder = cleanNumber(rowValue(inventory, yard.inventoryColumns[1])) || 0;
      const backordered = cleanNumber(rowValue(inventory, yard.inventoryColumns[2])) || 0;
      const inventoryPosition = Math.round(available / item.toPlt) + Math.round(onOrder / item.toPlt) - Math.round(backordered / item.toPlt);
      const minimumOrder = Math.max(Math.round((minimumOrderSales === null ? item.toPlt : minimumOrderSales) / item.toPlt), 1);
      const signature = decisionSignature([
        weeklyDemand,
        leadWeeks,
        safety,
        reorderPoint,
        inventoryPosition,
        inventoryPosition - reorderPoint,
        minimumOrder
      ]);
      if (!signature) continue;
      candidates.push({ itemId: item.itemId, sourceRow: item.sourceRow, signature, signatureValues: [
        weeklyDemand,
        leadWeeks,
        safety,
        reorderPoint,
        inventoryPosition,
        inventoryPosition - reorderPoint,
        minimumOrder
      ] });
    }
    const calculationSheet = workbookSheet(workbook, yard.sheet);
    if (!calculationSheet) {
      missingSheets.push(yard.sheet);
      continue;
    }
    const calculationRows = [];
    calculationSheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
      if (rowNumber === 1) return;
      const capacity = cleanNumber(rowValue(row, 17));
      const signatureColumns = [10, 11, 12, 13, 15, 16, 18];
      const signatureValues = signatureColumns.map((column) => cleanNumber(rowValue(row, column)));
      const derivedSignatureColumns = [];
      if (signatureValues[4] === null && signatureValues[5] !== null && signatureValues[3] !== null) {
        signatureValues[4] = signatureValues[5] + signatureValues[3];
        derivedSignatureColumns.push(15);
      }
      if (signatureValues[5] === null && signatureValues[4] !== null && signatureValues[3] !== null) {
        signatureValues[5] = signatureValues[4] - signatureValues[3];
        derivedSignatureColumns.push(16);
      }
      const hasEvidence = capacity !== null || signatureValues.some((value) => value !== null);
      if (!hasEvidence) return;
      calculationRows.push({
        sourceRow: rowNumber,
        capacity,
        signatureValues,
        signature: decisionSignature(signatureValues),
        derivedSignatureColumns,
        hasEvidence
      });
    });
    const matched = matchSmartScmDecisionCapacityRows({ yard, candidates, calculationRows });
    capacities.push(...matched.capacities);
    provenance.push(...matched.provenance);
    summaries.push({ yard: yard.code, ...matched.summary });
  }
  return {
    capacities,
    provenance,
    mapped: capacities.length,
    mappedZero: capacities.filter((row) => row.capacity_pallets === 0).length,
    ambiguous: summaries.reduce((sum, summary) => sum + summary.ambiguous, 0),
    unmatched: summaries.reduce((sum, summary) => sum + summary.unmatched, 0),
    unresolved: summaries.reduce((sum, summary) => sum + summary.unresolvedCapacityRows, 0),
    defaultRows: summaries.reduce((sum, summary) => sum + summary.defaultRows, 0),
    mappedByMethod: summaries.reduce((totals, summary) => {
      for (const [method, count] of Object.entries(summary.mappedByMethod)) {
        totals[method] = Number(totals[method] || 0) + Number(count || 0);
      }
      return totals;
    }, {}),
    yardSummaries: summaries,
    warning: missingSheets.length ? `Capacity calculation sheets were not found: ${missingSheets.join(", ")}.` : null
  };
}


function parseDecisionWorkbook(workbook, sourceFileId) {
  const supplies = [];
  const oos = workbookSheet(workbook, "OutofStock") || workbookSheet(workbook, "outOfStock");
  if (oos) {
    const headers = headerMap(oos);
    const itemColumn = requiredColumn(headers, ["ID", "Internal ID"], "OutofStock ID");
    oos.eachRow({ includeEmpty: false }, (row, rowNumber) => {
      if (rowNumber === 1) return;
      const itemId = cleanNumber(rowValue(row, itemColumn));
      if (!Number.isInteger(itemId) || itemId <= 0) return;
      supplies.push({
        item_id: itemId,
        vendor: null,
        plant: null,
        status: "out_of_stock",
        available_pallets: 0,
        production_eta: null,
        vendor_reference: null,
        remarks: "Imported from OutofStock sheet",
        source: "decision_workbook",
        source_input_file_id: sourceFileId
      });
    });
  }
  const phaseOne = workbookSheet(workbook, "Phase1");
  if (!phaseOne && !oos) throw new Error("Decision workbook requires Phase1 or OutofStock sheet.");
  if (phaseOne) {
    const headers = headerMap(phaseOne);
    const itemColumn = optionalColumn(headers, ["Internal ID", "ID"]);
    const plantColumn = optionalColumn(headers, ["Pickup Plant", "Plant"]);
    const currentColumn = optionalColumn(headers, ["Vendor Current"]);
    if (itemColumn && currentColumn) {
      const knownOos = new Set(supplies.map((row) => String(row.item_id)));
      phaseOne.eachRow({ includeEmpty: false }, (row, rowNumber) => {
        if (rowNumber === 1) return;
        const itemId = cleanNumber(rowValue(row, itemColumn));
        const available = cleanNumber(rowValue(row, currentColumn));
        if (!Number.isInteger(itemId) || itemId <= 0 || available === null || available <= 0 || knownOos.has(String(itemId))) return;
        supplies.push({
          item_id: itemId,
          vendor: null,
          plant: cleanText(rowValue(row, plantColumn)) || null,
          status: "available",
          available_pallets: available,
          production_eta: null,
          vendor_reference: null,
          remarks: "Imported vendor availability; confirm with vendor before execution",
          source: "decision_workbook",
          source_input_file_id: sourceFileId
        });
      });
    }
  }
  const capacityResult = parseSmartScmDecisionCapacities(workbook);
  return { supplies, capacities: capacityResult.capacities, capacityProvenance: capacityResult.provenance, summary: {
    supplySnapshots: supplies.length, outOfStock: supplies.filter((row) => row.status === "out_of_stock").length,
    capacityMappings: capacityResult.mapped,
    zeroCapacityMappings: capacityResult.mappedZero,
    capacityMappingsByMethod: capacityResult.mappedByMethod,
    defaultCapacityRows: capacityResult.defaultRows,
    unresolvedCapacityRows: capacityResult.unresolved,
    ambiguousCapacityRows: capacityResult.ambiguous,
    unmatchedCapacityRows: capacityResult.unmatched,
    capacityYards: capacityResult.yardSummaries,
    capacityWarning: capacityResult.warning
  } };
}

async function prepareWorkbookImport(file) {
  if (["decision_tree", "decision_script"].includes(file.slot)) {
    return { type: "reference", summary: { reference: true } };
  }
  const workbook = await readWorkbook(file.storage_path);
  if (file.slot === "item_master") return { type: "item_master", ...parseItemMaster(workbook) };
  if (file.slot === "sales_data") return { type: "sales_data", ...parseSalesData(workbook, file.id) };
  if (file.slot === "decision_workbook") return { type: "decision_workbook", ...parseDecisionWorkbook(workbook, file.id) };
  throw new Error("Unsupported Smart SCM input type.");
}

async function reconcileDecisionCapacities(file, prepared) {
  const reset = await query(
    `UPDATE scm_smart_item_yard_policies
        SET capacity_pallets = CASE WHEN eligible THEN 25 ELSE NULL END,
            capacity_source = 'default',
            capacity_source_input_file_id = NULL,
            capacity_source_sheet = NULL,
            capacity_source_row = NULL,
            capacity_match_method = NULL,
            updated_at = now()
      WHERE capacity_manually_overridden = false
        AND capacity_source IN ('decision_workbook', 'legacy_import')`
  );

  await query("DELETE FROM scm_smart_capacity_import_rows WHERE source_input_file_id = $1", [file.id]);
  const provenanceColumns = [
    "source_input_file_id", "yard_code", "location_id", "sheet_name", "source_row",
    "item_id", "capacity_pallets", "mapping_status", "match_method", "signature",
    "candidate_item_ids", "details"
  ];
  const provenanceRows = (prepared.capacityProvenance || []).map((row) => ({
    source_input_file_id: file.id,
    yard_code: row.yardCode,
    location_id: row.locationId,
    sheet_name: row.sheetName,
    source_row: row.sourceRow,
    item_id: row.itemId,
    capacity_pallets: row.capacityPallets,
    mapping_status: row.mappingStatus,
    match_method: row.matchMethod,
    signature: row.signature,
    candidate_item_ids: row.candidateItemIds || [],
    details: JSON.stringify(row.details || {})
  }));
  if (provenanceRows.length) {
    await bulkStatement({
      rows: provenanceRows,
      columns: provenanceColumns,
      chunkSize: 200,
      prefix: `INSERT INTO scm_smart_capacity_import_rows (${provenanceColumns.join(", ")})`
    });
  }

  await query(
    `UPDATE scm_smart_capacity_import_rows imported
        SET mapping_status = 'unresolved_policy_missing'
      WHERE imported.source_input_file_id = $1
        AND imported.mapping_status = 'matched'
        AND NOT EXISTS (
          SELECT 1 FROM scm_smart_item_yard_policies policy
           WHERE policy.item_id = imported.item_id
             AND policy.location_id = imported.location_id
        )`,
    [file.id]
  );
  await query(
    `UPDATE scm_smart_capacity_import_rows imported
        SET mapping_status = 'skipped_ineligible'
       FROM scm_smart_item_yard_policies policy
      WHERE imported.source_input_file_id = $1
        AND imported.mapping_status = 'matched'
        AND policy.item_id = imported.item_id
        AND policy.location_id = imported.location_id
        AND policy.eligible = false`,
    [file.id]
  );
  await query(
    `UPDATE scm_smart_capacity_import_rows imported
        SET mapping_status = 'skipped_manual_override'
       FROM scm_smart_item_yard_policies policy
      WHERE imported.source_input_file_id = $1
        AND imported.mapping_status = 'matched'
        AND policy.item_id = imported.item_id
        AND policy.location_id = imported.location_id
        AND policy.capacity_manually_overridden = true`,
    [file.id]
  );

  for (const group of chunks(prepared.capacities || [], 200)) {
    const params = [];
    const values = group.map((capacity) => {
      params.push(
        capacity.item_id,
        capacity.location_id,
        capacity.capacity_pallets,
        capacity.source_sheet,
        capacity.source_row,
        capacity.match_method
      );
      return `($${params.length - 5}, $${params.length - 4}, $${params.length - 3}, $${params.length - 2}, $${params.length - 1}, $${params.length})`;
    });
    params.push(file.id);
    await query(
      `UPDATE scm_smart_item_yard_policies policy
          SET capacity_pallets = imported.capacity_pallets::numeric,
              capacity_source = 'decision_workbook',
              capacity_source_input_file_id = $${params.length}::bigint,
              capacity_source_sheet = imported.source_sheet::text,
              capacity_source_row = imported.source_row::integer,
              capacity_match_method = imported.match_method::text,
              updated_at = now()
         FROM (VALUES ${values.join(", ")})
              AS imported(item_id, location_id, capacity_pallets, source_sheet, source_row, match_method)
        WHERE policy.item_id = imported.item_id::bigint
          AND policy.location_id = imported.location_id::bigint
          AND policy.eligible = true
          AND policy.capacity_manually_overridden = false`,
      params
    );
  }

  const statusResult = await query(
    `SELECT mapping_status, COUNT(*)::int AS count
       FROM scm_smart_capacity_import_rows
      WHERE source_input_file_id = $1
      GROUP BY mapping_status`,
    [file.id]
  );
  const statuses = Object.fromEntries(statusResult.rows.map((row) => [row.mapping_status, Number(row.count)]));
  return {
    priorDecisionCapacitiesReset: reset.rowCount,
    capacityRowsRecorded: provenanceRows.length,
    capacityApplied: Number(statuses.matched || 0),
    capacityManualOverridesSkipped: Number(statuses.skipped_manual_override || 0),
    capacityIneligibleSkipped: Number(statuses.skipped_ineligible || 0),
    capacityPoliciesMissing: Number(statuses.unresolved_policy_missing || 0),
    capacityReconciliationStatuses: statuses
  };
}

async function applyPreparedImport(file, prepared) {
  if (prepared.type === "item_master") {
    const itemColumns = [
      "item_id", "item_name", "item_description", "vendor", "vendor_code", "series", "stock_unit",
      "to_plt", "to_lyr", "to_sec", "to_pcs", "lead_time_days", "plant", "vendor_yard", "pallet_weight_lbs",
      "inventory_turnover", "average_soh_days", "velocity_class", "purchase_lead_time_days",
      "safety_stock_level", "safety_stock_days", "seasonal_demand", "expected_demand_change",
      "inactive", "discontinued", "source_input_file_id"
    ];
    const items = prepared.items.map((row) => ({ ...row, source_input_file_id: file.id }));
    await bulkStatement({
      rows: items,
      columns: itemColumns,
      chunkSize: 100,
      prefix: `INSERT INTO scm_smart_item_policies (${itemColumns.join(", ")})`,
      suffix: `ON CONFLICT (item_id) DO UPDATE SET
        item_name = EXCLUDED.item_name,
        item_description = EXCLUDED.item_description,
        vendor = EXCLUDED.vendor,
        vendor_code = EXCLUDED.vendor_code,
        series = EXCLUDED.series,
        stock_unit = EXCLUDED.stock_unit,
        to_plt = EXCLUDED.to_plt,
        to_lyr = EXCLUDED.to_lyr,
        to_sec = EXCLUDED.to_sec,
        to_pcs = EXCLUDED.to_pcs,
        lead_time_days = EXCLUDED.lead_time_days,
        plant = EXCLUDED.plant,
        pallet_weight_lbs = EXCLUDED.pallet_weight_lbs,
        vendor_yard = CASE WHEN scm_smart_item_policies.vendor_yard_id IS NULL AND scm_smart_item_policies.updated_by IS NULL THEN EXCLUDED.vendor_yard ELSE scm_smart_item_policies.vendor_yard END,
        inventory_turnover = EXCLUDED.inventory_turnover,
        average_soh_days = EXCLUDED.average_soh_days,
        velocity_class = EXCLUDED.velocity_class,
        purchase_lead_time_days = EXCLUDED.purchase_lead_time_days,
        safety_stock_level = EXCLUDED.safety_stock_level,
        safety_stock_days = EXCLUDED.safety_stock_days,
        seasonal_demand = EXCLUDED.seasonal_demand,
        expected_demand_change = EXCLUDED.expected_demand_change,
        inactive = EXCLUDED.inactive,
        discontinued = EXCLUDED.discontinued,
        source_input_file_id = EXCLUDED.source_input_file_id,
        updated_at = now()`
    });
    const yardColumns = ["item_id", "location_id", "yard_code", "eligible", "capacity_pallets", "service_quantile", "minimum_safety_pallets", "source_input_file_id"];
    const yards = prepared.yardPolicies.map((row) => ({ ...row, source_input_file_id: file.id }));
    await bulkStatement({
      rows: yards,
      columns: yardColumns,
      chunkSize: 200,
      prefix: `INSERT INTO scm_smart_item_yard_policies (${yardColumns.join(", ")})`,
      suffix: `ON CONFLICT (item_id, location_id) DO UPDATE SET
        yard_code = EXCLUDED.yard_code,
        eligible = CASE WHEN scm_smart_item_yard_policies.manually_overridden THEN scm_smart_item_yard_policies.eligible ELSE EXCLUDED.eligible END,
        capacity_pallets = CASE
          WHEN NOT (CASE WHEN scm_smart_item_yard_policies.manually_overridden THEN scm_smart_item_yard_policies.eligible ELSE EXCLUDED.eligible END) THEN NULL
          ELSE COALESCE(scm_smart_item_yard_policies.capacity_pallets, EXCLUDED.capacity_pallets, 25)
        END,
        capacity_manually_overridden = CASE
          WHEN CASE WHEN scm_smart_item_yard_policies.manually_overridden THEN scm_smart_item_yard_policies.eligible ELSE EXCLUDED.eligible END
            THEN scm_smart_item_yard_policies.capacity_manually_overridden
          ELSE false
        END,
        capacity_source = CASE
          WHEN CASE WHEN scm_smart_item_yard_policies.manually_overridden THEN scm_smart_item_yard_policies.eligible ELSE EXCLUDED.eligible END
            THEN scm_smart_item_yard_policies.capacity_source
          ELSE 'default'
        END,
        capacity_source_input_file_id = CASE
          WHEN CASE WHEN scm_smart_item_yard_policies.manually_overridden THEN scm_smart_item_yard_policies.eligible ELSE EXCLUDED.eligible END
            THEN scm_smart_item_yard_policies.capacity_source_input_file_id
          ELSE NULL
        END,
        capacity_source_sheet = CASE
          WHEN CASE WHEN scm_smart_item_yard_policies.manually_overridden THEN scm_smart_item_yard_policies.eligible ELSE EXCLUDED.eligible END
            THEN scm_smart_item_yard_policies.capacity_source_sheet
          ELSE NULL
        END,
        capacity_source_row = CASE
          WHEN CASE WHEN scm_smart_item_yard_policies.manually_overridden THEN scm_smart_item_yard_policies.eligible ELSE EXCLUDED.eligible END
            THEN scm_smart_item_yard_policies.capacity_source_row
          ELSE NULL
        END,
        capacity_match_method = CASE
          WHEN CASE WHEN scm_smart_item_yard_policies.manually_overridden THEN scm_smart_item_yard_policies.eligible ELSE EXCLUDED.eligible END
            THEN scm_smart_item_yard_policies.capacity_match_method
          ELSE NULL
        END,
        service_quantile = CASE WHEN scm_smart_item_yard_policies.manually_overridden THEN scm_smart_item_yard_policies.service_quantile ELSE EXCLUDED.service_quantile END,
        minimum_safety_pallets = CASE WHEN scm_smart_item_yard_policies.manually_overridden THEN scm_smart_item_yard_policies.minimum_safety_pallets ELSE EXCLUDED.minimum_safety_pallets END,
        source_input_file_id = EXCLUDED.source_input_file_id,
        updated_at = now()`
    });
    return { itemPoliciesApplied: items.length, itemYardPoliciesApplied: yards.length };
  }
  if (prepared.type === "sales_data") {
    await query("DELETE FROM scm_smart_sales_facts WHERE source = 'workbook'");
    const columns = ["source", "source_key", "transaction_date", "document_ref", "item_id", "item_name", "quantity", "delivery_method", "location_id", "yard_code", "sales_amount", "source_input_file_id"];
    await bulkStatement({
      rows: prepared.facts,
      columns,
      chunkSize: 250,
      prefix: `INSERT INTO scm_smart_sales_facts (${columns.join(", ")})`,
      suffix: "ON CONFLICT (source_key) DO NOTHING"
    });
    return { salesFactsApplied: prepared.facts.length };
  }
  if (prepared.type === "decision_workbook") {
    await query("DELETE FROM scm_smart_vendor_supply WHERE source = 'decision_workbook'");
    if (prepared.supplies.length) {
      const columns = ["item_id", "vendor", "plant", "status", "available_pallets", "production_eta", "vendor_reference", "remarks", "source", "source_input_file_id"];
      await bulkStatement({
        rows: prepared.supplies,
        columns,
        chunkSize: 250,
        prefix: `INSERT INTO scm_smart_vendor_supply (${columns.join(", ")})`
      });
    }
    return {
      vendorSupplySnapshotsApplied: prepared.supplies.length,
      ...await reconcileDecisionCapacities(file, prepared)
    };
  }
  return {};
}

function publicFile(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    slot: row.slot,
    version: Number(row.version),
    originalFilename: row.original_filename,
    contentType: row.content_type,
    byteSize: Number(row.byte_size || 0),
    sha256: row.sha256,
    status: row.status,
    validation: row.validation || {},
    importedSummary: row.imported_summary || {},
    active: Boolean(row.active),
    uploadedBy: row.uploaded_by,
    uploadedAt: row.uploaded_at,
    importedAt: row.imported_at,
    activatedAt: row.activated_at
  };
}

export async function listSmartScmInputFiles() {
  const result = await query(`SELECT * FROM scm_smart_input_files ORDER BY slot, version DESC`);
  return result.rows.map(publicFile);
}

export async function getSmartScmInputFile(id) {
  const result = await query("SELECT * FROM scm_smart_input_files WHERE id = $1", [Number(id)]);
  return result.rows[0] || null;
}

export async function storeSmartScmInputFile({ slot, filename, contentType, buffer, operatorId }) {
  const resolvedSlot = inputSlot(slot);
  const originalFilename = safeOriginalFilename(filename);
  assertFileExtension(resolvedSlot, originalFilename);
  if (!Buffer.isBuffer(buffer) || !buffer.length) throw Object.assign(new Error("Select a non-empty file."), { status: 400 });
  const maxBytes = config.smartScm.maxInputMb * 1024 * 1024;
  if (buffer.length > maxBytes) throw Object.assign(new Error(`File exceeds the ${config.smartScm.maxInputMb} MB Smart SCM limit.`), { status: 413 });
  await fs.mkdir(config.smartScm.inputDir, { recursive: true });
  const sha256 = crypto.createHash("sha256").update(buffer).digest("hex");
  const versionResult = await query("SELECT COALESCE(MAX(version), 0) + 1 AS version FROM scm_smart_input_files WHERE slot = $1", [resolvedSlot.key]);
  const version = Number(versionResult.rows[0]?.version || 1);
  const storageName = `${resolvedSlot.key}-v${version}-${sha256.slice(0, 12)}${path.extname(originalFilename).toLowerCase()}`;
  const storagePath = path.join(config.smartScm.inputDir, storageName);
  await fs.writeFile(storagePath, buffer, { flag: "wx" }).catch(async (error) => {
    if (error.code !== "EEXIST") throw error;
  });
  const inserted = await query(
    `INSERT INTO scm_smart_input_files (
       slot, version, original_filename, content_type, byte_size, sha256, storage_path, status, uploaded_by
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'validating', $8)
     RETURNING *`,
    [resolvedSlot.key, version, originalFilename, contentType || "application/octet-stream", buffer.length, sha256, storagePath, operatorId || null]
  );
  const file = inserted.rows[0];
  try {
    const prepared = await prepareWorkbookImport(file);
    const ready = await query(
      `UPDATE scm_smart_input_files
          SET status = 'ready', validation = $2::jsonb
        WHERE id = $1
        RETURNING *`,
      [file.id, JSON.stringify({ ok: true, ...prepared.summary })]
    );
    await writeAudit({
      actorOperatorId: operatorId,
      source: "smart_scm",
      action: "smart_scm.input.upload",
      details: { fileId: Number(file.id), slot: resolvedSlot.key, version, originalFilename, sha256, validation: prepared.summary }
    });
    return publicFile(ready.rows[0]);
  } catch (error) {
    const invalid = await query(
      `UPDATE scm_smart_input_files
          SET status = 'invalid', validation = $2::jsonb
        WHERE id = $1
        RETURNING *`,
      [file.id, JSON.stringify({ ok: false, error: error.message })]
    );
    await writeAudit({
      actorOperatorId: operatorId,
      source: "smart_scm",
      action: "smart_scm.input.invalid",
      details: { fileId: Number(file.id), slot: resolvedSlot.key, version, error: error.message }
    });
    return publicFile(invalid.rows[0]);
  }
}

export async function activateSmartScmInputFile(id, operatorId) {
  const file = await getSmartScmInputFile(id);
  if (!file) throw Object.assign(new Error("Smart SCM input file was not found."), { status: 404 });
  if (file.status !== "ready") throw Object.assign(new Error("Only a validated Smart SCM file can be activated."), { status: 409 });
  const prepared = await prepareWorkbookImport(file);
  let activeDecisionFile = null;
  let activeDecisionPrepared = null;
  if (file.slot === "item_master") {
    const activeDecisionResult = await query(
      "SELECT * FROM scm_smart_input_files WHERE slot = 'decision_workbook' AND active = true ORDER BY version DESC LIMIT 1"
    );
    activeDecisionFile = activeDecisionResult.rows[0] || null;
    if (activeDecisionFile) activeDecisionPrepared = await prepareWorkbookImport(activeDecisionFile);
  }
  let activationSummary = { ...(prepared.summary || {}) };
  const activated = await withTransaction(async () => {
    const applySummary = await applyPreparedImport(file, prepared);
    activationSummary = { ...activationSummary, ...applySummary };
    if (activeDecisionFile && activeDecisionPrepared) {
      const decisionApplySummary = await applyPreparedImport(activeDecisionFile, activeDecisionPrepared);
      const decisionSummary = {
        ...(activeDecisionPrepared.summary || {}),
        ...decisionApplySummary,
        reappliedAfterItemMasterFileId: Number(file.id)
      };
      activationSummary.reappliedDecisionWorkbook = {
        fileId: Number(activeDecisionFile.id),
        version: Number(activeDecisionFile.version),
        ...(activeDecisionPrepared.summary || {}),
        ...decisionApplySummary
      };
      await query(
        `UPDATE scm_smart_input_files
            SET imported_summary = $2::jsonb,
                imported_at = now()
          WHERE id = $1`,
        [activeDecisionFile.id, JSON.stringify(decisionSummary)]
      );
    }
    await query("UPDATE scm_smart_input_files SET active = false WHERE slot = $1 AND id <> $2", [file.slot, file.id]);
    const result = await query(
      `UPDATE scm_smart_input_files
          SET active = true,
              imported_summary = $2::jsonb,
              imported_at = now(),
              activated_at = now()
        WHERE id = $1
        RETURNING *`,
      [file.id, JSON.stringify(activationSummary)]
    );
    return result.rows[0];
  });
  await writeAudit({
    actorOperatorId: operatorId,
    source: "smart_scm",
    action: "smart_scm.input.activate",
    details: { fileId: Number(file.id), slot: file.slot, version: Number(file.version), summary: activationSummary }
  });
  return publicFile(activated);
}

export async function smartScmInputDownload(id) {
  const file = await getSmartScmInputFile(id);
  if (!file) throw Object.assign(new Error("Smart SCM input file was not found."), { status: 404 });
  return {
    path: file.storage_path,
    filename: file.original_filename,
    contentType: file.content_type || "application/octet-stream"
  };
}

function parseCsvRows(buffer) {
  const source = buffer.toString("utf8").replace(/^\uFEFF/, "");
  const rows = [];
  let row = [];
  let value = "";
  let quoted = false;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (quoted) {
      if (character === '"' && source[index + 1] === '"') {
        value += '"';
        index += 1;
      } else if (character === '"') {
        quoted = false;
      } else {
        value += character;
      }
      continue;
    }
    if (character === '"') quoted = true;
    else if (character === ",") {
      row.push(value);
      value = "";
    } else if (character === "\n") {
      row.push(value.replace(/\r$/, ""));
      rows.push(row);
      row = [];
      value = "";
    } else value += character;
  }
  if (value || row.length) {
    row.push(value.replace(/\r$/, ""));
    rows.push(row);
  }
  return rows;
}

function salesCsvFactsFromMatrix(matrix = [], sha256 = "") {
  if (matrix.length < 2) throw new Error("Sales CSV has no data rows.");
  const headers = new Map(matrix[0].map((value, index) => [normalizeHeader(value), index]));
  const column = (names, required = false) => {
    for (const name of names) {
      const found = headers.get(normalizeHeader(name));
      if (found !== undefined) return found;
    }
    if (required) throw new Error(`Sales CSV column ${names[0]} was not found.`);
    return null;
  };
  const columns = {
    itemId: column(["Internal ID", "Item Internal ID", "Item ID", "internalid"], true),
    date: column(["Date", "Transaction Date", "Order Date", "trandate"], true),
    document: column(["Document Number", "Order Number", "Document", "Tran ID", "tranid"]),
    itemName: column(["Item", "Item Name", "Name"]),
    quantity: column(["Quantity", "Qty", "Sales Quantity"], true),
    method: column(["Delivery Method", "Method", "Ship Method"]),
    location: column(["Location", "Yard", "Line Location", "Location (Line)"], true),
    salesAmount: column(["Sales Amount", "Amount", "Net Amount"]),
    status: column(["Status", "Order Status"])
  };
  const facts = [];
  let rejectedRows = 0;
  matrix.slice(1).forEach((row, index) => {
    const itemId = cleanNumber(row[columns.itemId]);
    const transactionDate = excelDate(row[columns.date]);
    const rawQuantity = cleanNumber(row[columns.quantity]);
    const quantity = rawQuantity === null ? null : Math.abs(rawQuantity);
    const yard = canonicalYard(row[columns.location]);
    const status = columns.status === null ? "" : cleanText(row[columns.status]);
    if (!Number.isInteger(itemId) || itemId <= 0 || !transactionDate || !yard || !(quantity > 0) || /cancel/i.test(status)) {
      if (row.some((value) => cleanText(value))) rejectedRows += 1;
      return;
    }
    facts.push({
      source: "csv",
      source_key: `csv:${sha256}:${index + 2}`,
      transaction_date: transactionDate,
      document_ref: columns.document === null ? null : cleanText(row[columns.document]) || null,
      item_id: itemId,
      item_name: columns.itemName === null ? null : cleanText(row[columns.itemName]) || null,
      quantity,
      delivery_method: columns.method === null ? null : cleanText(row[columns.method]) || null,
      location_id: yard.locationId,
      yard_code: yard.code,
      sales_amount: columns.salesAmount === null ? null : cleanNumber(row[columns.salesAmount])
    });
  });
  if (!facts.length) throw new Error("Sales CSV has no valid yard sales rows.");
  return { facts, rejectedRows };
}

export async function importSmartScmSalesCsv({ buffer, filename = "sales.csv", operatorId = null } = {}) {
  const originalFilename = safeOriginalFilename(filename);
  if (path.extname(originalFilename).toLowerCase() !== ".csv") {
    throw Object.assign(new Error("Raw sales history requires a CSV file."), { status: 400 });
  }
  if (!Buffer.isBuffer(buffer) || !buffer.length) throw Object.assign(new Error("Select a non-empty sales CSV."), { status: 400 });
  const maxBytes = config.smartScm.maxInputMb * 1024 * 1024;
  if (buffer.length > maxBytes) throw Object.assign(new Error(`File exceeds the ${config.smartScm.maxInputMb} MB Smart SCM limit.`), { status: 413 });
  const sha256 = crypto.createHash("sha256").update(buffer).digest("hex");
  const parsed = salesCsvFactsFromMatrix(parseCsvRows(buffer), sha256);
  const dates = parsed.facts.map((fact) => fact.transaction_date).sort();
  const itemCount = new Set(parsed.facts.map((fact) => fact.item_id)).size;
  const summary = {
    filename: originalFilename,
    sha256,
    byteSize: buffer.length,
    facts: parsed.facts.length,
    rejectedRows: parsed.rejectedRows,
    itemCount,
    coverageStart: dates[0],
    coverageEnd: dates.at(-1)
  };
  await withTransaction(async () => {
    await query("DELETE FROM scm_smart_sales_facts WHERE source IN ('csv', 'netsuite')");
    await bulkStatement({
      rows: parsed.facts,
      columns: [
        "source", "source_key", "transaction_date", "document_ref", "item_id",
        "item_name", "quantity", "delivery_method", "location_id", "yard_code", "sales_amount"
      ],
      chunkSize: 300,
      prefix: `INSERT INTO scm_smart_sales_facts (
        source, source_key, transaction_date, document_ref, item_id,
        item_name, quantity, delivery_method, location_id, yard_code, sales_amount
      )`,
      suffix: "ON CONFLICT (source_key) DO NOTHING"
    });
    await query(
      `UPDATE scm_smart_sync_state
          SET sales_status = 'ready',
              sales_started_at = now(),
              sales_synced_at = now(),
              sales_coverage_start = $1::date,
              sales_synced_through = $2::date,
              sales_fact_count = $3,
              sales_error = NULL,
              sales_source = 'csv',
              sales_filename = $4,
              sales_sha256 = $5,
              updated_at = now()
        WHERE id = 1`,
      [summary.coverageStart, summary.coverageEnd, summary.facts, originalFilename, sha256]
    );
  });
  await writeAudit({
    actorOperatorId: operatorId,
    source: "smart_scm",
    action: "smart_scm.sales_csv.replace",
    details: summary
  });
  return summary;
}

function vendorResponseRowsFromMatrix(matrix = []) {
  if (matrix.length < 2) throw new Error("Vendor response file has no data rows.");
  const headers = new Map(matrix[0].map((value, index) => [normalizeHeader(value), index]));
  const column = (names, required = false) => {
    for (const name of names) {
      const found = headers.get(normalizeHeader(name));
      if (found !== undefined) return found;
    }
    if (required) throw new Error(`Vendor response column ${names[0]} was not found.`);
    return null;
  };
  const columns = {
    lineId: column(["Proposal Line ID", "proposalLineId", "Line ID"], true),
    status: column(["Response Status", "Status"], true),
    confirmed: column(["Confirmed Pallets", "Confirmed Qty"]),
    unavailable: column(["Unavailable Pallets", "Unavailable Qty"]),
    readyDate: column(["Ready Date", "ETA"]),
    vendorReference: column(["Vendor Reference", "Vendor Ref"]),
    poReference: column(["NetSuite PO Reference", "PO Reference", "PO Ref"]),
    packingNumber: column(["Packing Number", "Packing Ref"]),
    creditStatus: column(["Credit Status"]),
    remarks: column(["Remarks", "Notes"])
  };
  return matrix.slice(1).map((row) => ({
    proposalLineId: cleanNumber(row[columns.lineId]),
    responseStatus: cleanText(row[columns.status]).toLowerCase().replaceAll(" ", "_"),
    confirmedPallets: cleanNumber(columns.confirmed === null ? null : row[columns.confirmed]) || 0,
    unavailablePallets: columns.unavailable === null ? undefined : cleanNumber(row[columns.unavailable]),
    readyDate: excelDate(columns.readyDate === null ? null : row[columns.readyDate]),
    vendorReference: cleanText(columns.vendorReference === null ? null : row[columns.vendorReference]),
    netsuitePoReference: cleanText(columns.poReference === null ? null : row[columns.poReference]),
    packingNumber: cleanText(columns.packingNumber === null ? null : row[columns.packingNumber]),
    creditStatus: cleanText(columns.creditStatus === null ? null : row[columns.creditStatus]),
    remarks: cleanText(columns.remarks === null ? null : row[columns.remarks]),
    responseSource: "bulk_file"
  })).filter((row) => Number.isInteger(row.proposalLineId) && row.proposalLineId > 0 && row.responseStatus);
}

export async function parseSmartScmVendorResponseFile(buffer, filename = "responses.csv") {
  const extension = path.extname(filename).toLowerCase();
  let matrix;
  if (extension === ".csv") {
    matrix = parseCsvRows(buffer);
  } else if (extension === ".xlsx") {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer);
    const sheet = workbook.worksheets[0];
    if (!sheet) throw new Error("Vendor response workbook has no worksheet.");
    matrix = [];
    sheet.eachRow({ includeEmpty: true }, (row) => {
      const values = [];
      for (let columnIndex = 1; columnIndex <= row.cellCount; columnIndex += 1) {
        values.push(excelCellValue(row.getCell(columnIndex)));
      }
      matrix.push(values);
    });
  } else {
    throw Object.assign(new Error("Vendor responses require a CSV or XLSX file."), { status: 400 });
  }
  const responses = vendorResponseRowsFromMatrix(matrix);
  if (!responses.length) throw new Error("Vendor response file has no valid proposal line responses.");
  return responses;
}
