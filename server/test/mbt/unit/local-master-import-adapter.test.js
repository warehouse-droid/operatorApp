import assert from "node:assert/strict";
import test from "node:test";

function futureAdapter() {
  return import("../../../src/mbt/local-master-import-adapter.js");
}

/** @param {unknown} error @param {string} code */
function hasCode(error, code) {
  return Boolean(error && typeof error === "object" && error.code === code);
}

test("P3-F09 CSV: local resources expose versioned server-owned templates and never yards", async () => {
  const { getLocalMasterImportDefinition } = await futureAdapter();
  const expected = {
    local_items: {
      version: "mbt-local-items-csv-v3",
      headers: [
        "item_code", "display_name", "description", "item_type", "rental_period_days",
        "category", "pricing_mode", "applicable_service_types",
        "applicable_legacy_source_types", "bin_type_code", "bin_capacity_yards",
        "netsuite_mapping_local_key", "active", "expected_revision"
      ]
    },
    materials: {
      version: "mbt-materials-csv-v1",
      headers: ["material_code", "display_name", "description", "active", "expected_revision"]
    },
    dump_sites: {
      version: "mbt-dump-sites-csv-v2",
      headers: [
        "dump_site_code", "display_name", "address_line_1", "address_line_2", "city",
        "region", "postal_code", "country_code", "phone", "latitude", "longitude",
        "item_code", "material_code", "accepted", "scale_ticket_required", "notes", "active",
        "expected_revision"
      ]
    }
  };

  for (const [resource, expectation] of Object.entries(expected)) {
    const definition = getLocalMasterImportDefinition(resource);
    assert.equal(definition.resource, resource);
    assert.equal(definition.schemaVersion, expectation.version);
    assert.deepEqual(definition.headers, expectation.headers);
    assert.equal(Object.isFrozen(definition.headers), true);
  }
  assert.throws(
    () => getLocalMasterImportDefinition("yards"),
    (error) => hasCode(error, "MBT_IMPORT_RESOURCE_INVALID")
  );
});

test("P3-F09 CSV: local-item rows normalize through the manual command shape", async () => {
  const { parseLocalMasterCsv } = await futureAdapter();
  const parsed = await parseLocalMasterCsv({
    resource: "local_items",
    content: [
      "item_code,display_name,description,category,pricing_mode,applicable_service_types,applicable_legacy_source_types,bin_type_code,netsuite_mapping_local_key,active,expected_revision",
      "SYNTH_SERVICE,Synthetic service,Local only,service,rate_card,delivery|exchange,SO|TO,,,true,"
    ].join("\r\n")
  });

  assert.equal(parsed.schemaVersion, "mbt-local-items-csv-v3");
  assert.equal(parsed.rows.length, 1);
  const { payloadHash, ...row } = parsed.rows[0];
  assert.match(payloadHash, /^[0-9a-f]{64}$/u);
  assert.deepEqual(row, {
    rowNumber: 2,
    naturalKey: "SYNTH_SERVICE",
    itemCode: "SYNTH_SERVICE",
    displayName: "Synthetic service",
    description: "Local only",
    itemType: "delivery_fee",
    chargeBasis: "distance",
    densityLbsPerYard: null,
    rentalPeriodDays: null,
    category: "service",
    pricingMode: "rate_card",
    applicableServiceTypes: ["delivery", "exchange"],
    applicableLegacySourceTypes: ["SO", "TO"],
    binTypeCode: null,
    netSuiteMappingLocalKey: null,
    active: true
  });
  assert.match(parsed.fileHash, /^[0-9a-f]{64}$/u);
  assert.match(parsed.normalizedHash, /^[0-9a-f]{64}$/u);
});

test("local-item CSV creates a user-defined BIN capacity without a pre-existing BIN type code", async () => {
  const { parseLocalMasterCsv } = await futureAdapter();
  const parsed = await parseLocalMasterCsv({
    resource: "local_items",
    content: [
      "item_code,display_name,description,item_type,rental_period_days,bin_capacity_yards,active,expected_revision",
      "50YD,50 yard Bin,Future custom size,bin,14,50,true,"
    ].join("\r\n")
  });
  const { payloadHash, rowNumber, naturalKey, ...row } = parsed.rows[0];
  assert.match(payloadHash, /^[0-9a-f]{64}$/u);
  assert.equal(rowNumber, 2);
  assert.equal(naturalKey, "50YD");
  assert.deepEqual(row, {
    itemCode: "50YD",
    displayName: "50 yard Bin",
    description: "Future custom size",
    itemType: "bin",
    chargeBasis: "rental_period",
    densityLbsPerYard: null,
    rentalPeriodDays: 14,
    category: "bin_charge",
    pricingMode: "rental_item",
    applicableServiceTypes: ["delivery", "final_pickup", "loaded_pickup", "dump_return", "exchange"],
    applicableLegacySourceTypes: [],
    binTypeCode: null,
    binCapacityYards: 50,
    netSuiteMappingLocalKey: null,
    active: true
  });
});

test("P3-F09 CSV: materials and dump sites use strict booleans, revisions, coordinates and references", async () => {
  const { parseLocalMasterCsv } = await futureAdapter();
  const materials = await parseLocalMasterCsv({
    resource: "materials",
    content: [
      "material_code,display_name,description,active,expected_revision",
      "CLEAN_FILL,Clean fill,Synthetic material,false,7"
    ].join("\n")
  });
  const { payloadHash: materialHash, ...materialRow } = materials.rows[0];
  assert.match(materialHash, /^[0-9a-f]{64}$/u);
  assert.deepEqual(materialRow, {
    rowNumber: 2,
    naturalKey: "CLEAN_FILL",
    materialCode: "CLEAN_FILL",
    displayName: "Clean fill",
    description: "Synthetic material",
    active: false,
    expectedRevision: 7
  });

  const dumps = await parseLocalMasterCsv({
    resource: "dump_sites",
    content: [
      "dump_site_code,display_name,address_line_1,address_line_2,city,region,postal_code,country_code,phone,latitude,longitude,material_code,accepted,scale_ticket_required,notes,active,expected_revision",
      "SYNTH_DUMP,Synthetic dump,1 Example Rd,,Toronto,ON,A1A 1A1,CA,,43.1,-79.2,CLEAN_FILL,true,false,Local test,true,"
    ].join("\n")
  });
  const { payloadHash: dumpHash, ...dumpRow } = dumps.rows[0];
  assert.match(dumpHash, /^[0-9a-f]{64}$/u);
  assert.deepEqual(dumpRow, {
    rowNumber: 2,
    naturalKey: "SYNTH_DUMP",
    dumpSiteCode: "SYNTH_DUMP",
    displayName: "Synthetic dump",
    addressLine1: "1 Example Rd",
    addressLine2: "",
    city: "Toronto",
    region: "ON",
    postalCode: "A1A 1A1",
    countryCode: "CA",
    phone: "",
    latitude: "43.1",
    longitude: "-79.2",
    materialCode: "CLEAN_FILL",
    accepted: true,
    scaleTicketRequired: false,
    notes: "Local test",
    active: true
  });
});

test("P3-F09 CSV: duplicate identities and permissive scalar coercion fail before staging", async () => {
  const { parseLocalMasterCsv } = await futureAdapter();
  await assert.rejects(
    () => parseLocalMasterCsv({
      resource: "materials",
      content: [
        "material_code,display_name,description,active,expected_revision",
        "DUP,First,,true,",
        "DUP,Second,,true,"
      ].join("\n")
    }),
    (error) => hasCode(error, "MBT_IMPORT_DUPLICATE_IDENTITY")
  );
  await assert.rejects(
    () => parseLocalMasterCsv({
      resource: "materials",
      content: [
        "material_code,display_name,description,active,expected_revision",
        "BAD,Bad boolean,,yes,"
      ].join("\n")
    }),
    (error) => hasCode(error, "MBT_IMPORT_ROW_INVALID")
  );
  await assert.rejects(
    () => parseLocalMasterCsv({
      resource: "materials",
      content: [
        "material_code,display_name,description,active,expected_revision",
        "BAD,Bad revision,,true,1.5"
      ].join("\n")
    }),
    (error) => hasCode(error, "MBT_IMPORT_ROW_INVALID")
  );
});
