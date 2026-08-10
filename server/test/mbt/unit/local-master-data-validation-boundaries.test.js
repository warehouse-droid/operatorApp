import assert from "node:assert/strict";
import test from "node:test";

function futureService() {
  return import("../../../src/mbt/local-master-data-service.js");
}

/** @param {unknown} error @param {string} code @param {string} message */
function exactMbtError(error, code, message) {
  return Boolean(error && typeof error === "object"
    && error.name === "MbtError"
    && error.status === 400
    && error.code === code
    && error.message === message);
}

function localItem(overrides = {}) {
  return {
    itemCode: " bin_wash ",
    displayName: " Bin wash ",
    description: " Local cleaning service ",
    category: " SERVICE ",
    pricingMode: " CUSTOM_PRICE ",
    applicableServiceTypes: ["DELIVERY", "delivery", "exchange"],
    applicableLegacySourceTypes: ["so", "SO", "to"],
    binTypeCode: "14yd",
    netSuiteMappingLocalKey: "mbt.item:bin_wash",
    active: true,
    ...overrides
  };
}

function material(overrides = {}) {
  return {
    materialCode: " clean_fill ",
    displayName: " Clean fill ",
    description: " Synthetic material ",
    active: true,
    ...overrides
  };
}

function dumpSite(overrides = {}) {
  return {
    dumpSiteCode: " north_dump ",
    displayName: " North dump ",
    addressLine1: " 1 Test Road ",
    addressLine2: " ",
    city: " Toronto ",
    region: " ON ",
    postalCode: " M1M 1M1 ",
    countryCode: " ca ",
    phone: " 519-555-0100 ",
    latitude: "43.7000",
    longitude: "-79.4000",
    materialCode: " clean_fill ",
    accepted: true,
    scaleTicketRequired: false,
    notes: " Receipt optional ",
    active: true,
    ...overrides
  };
}

function step(overrides = {}) {
  return {
    sequenceNumber: 1,
    actionCode: " PICKUP_BIN ",
    displayName: " Pick up bin ",
    stopKind: " PICKUP ",
    locationRole: " CUSTOMER_SITE ",
    requiredAssetStatusBefore: null,
    requiredAssetStatusAfter: " ON_TRUCK ",
    required: true,
    ...overrides
  };
}

function evidence(overrides = {}) {
  return {
    stepActionCode: " PICKUP_BIN ",
    evidenceCode: " PICKUP_PHOTO ",
    evidenceType: " PHOTO ",
    minimumCount: 1,
    required: true,
    ...overrides
  };
}

function serviceTemplate(overrides = {}) {
  return {
    templateCode: " bin_delivery ",
    displayName: " Bin delivery ",
    description: " Synthetic workflow ",
    active: true,
    versionNumber: 1,
    status: "draft",
    requiredBinService: true,
    dumpSiteRequired: false,
    steps: [step()],
    evidenceRequirements: [evidence()],
    ...overrides
  };
}

test("P3-F09 validator: local-item canonicalization is deterministic and source-owned input is immutable", async () => {
  const { normalizeLocalMasterDataRow } = await futureService();
  const input = localItem({ expectedRevision: 7 });
  const before = structuredClone(input);
  const normalized = normalizeLocalMasterDataRow("local_items", input);

  assert.deepEqual(normalized, {
    itemCode: "BIN_WASH",
    displayName: "Bin wash",
    description: "Local cleaning service",
    itemType: "delivery_fee",
    chargeBasis: "distance",
    densityLbsPerYard: null,
    rentalPeriodDays: null,
    category: "service",
    pricingMode: "custom_price",
    applicableServiceTypes: ["delivery", "exchange"],
    applicableLegacySourceTypes: ["SO", "TO"],
    binTypeCode: "14YD",
    netSuiteMappingLocalKey: "mbt.item:bin_wash",
    active: true,
    expectedRevision: 7
  });
  assert.deepEqual(input, before);

  assert.deepEqual(normalizeLocalMasterDataRow("local_items", localItem({
    binTypeCode: null,
    netSuiteMappingLocalKey: null,
    expectedRevision: undefined
  })), {
    itemCode: "BIN_WASH",
    displayName: "Bin wash",
    description: "Local cleaning service",
    itemType: "delivery_fee",
    chargeBasis: "distance",
    densityLbsPerYard: null,
    rentalPeriodDays: null,
    category: "service",
    pricingMode: "custom_price",
    applicableServiceTypes: ["delivery", "exchange"],
    applicableLegacySourceTypes: ["SO", "TO"],
    binTypeCode: null,
    netSuiteMappingLocalKey: null,
    active: true
  });
  const withoutMapping = localItem();
  delete withoutMapping.netSuiteMappingLocalKey;
  assert.equal(Object.hasOwn(normalizeLocalMasterDataRow("local_items", withoutMapping), "netSuiteMappingLocalKey"), false);
});

test("P3-F09 validator: every unsupported local-item shape fails with the exact safe error", async (t) => {
  const { normalizeLocalMasterDataRow } = await futureService();
  const cases = [
    ["null row", null],
    ["array row", []],
    ["unknown field", localItem({ amountMinor: 1 })],
    ["category", localItem({ category: "money" })],
    ["pricing mode", localItem({ pricingMode: "fixed" })],
    ["bin type code", localItem({ binTypeCode: "bad type" })],
    ["mapping blank", localItem({ netSuiteMappingLocalKey: " " })],
    ["mapping grammar", localItem({ netSuiteMappingLocalKey: "Bad Key" })],
    ["item code", localItem({ itemCode: "BIN-WASH" })],
    ["name type", localItem({ displayName: 7 })],
    ["name blank", localItem({ displayName: " " })],
    ["name length", localItem({ displayName: "x".repeat(161) })],
    ["description type", localItem({ description: null })],
    ["description length", localItem({ description: "x".repeat(2001) })],
    ["service collection", localItem({ applicableServiceTypes: "delivery" })],
    ["service value", localItem({ applicableServiceTypes: ["unknown"] })],
    ["legacy collection", localItem({ applicableLegacySourceTypes: null })],
    ["legacy value", localItem({ applicableLegacySourceTypes: ["WO"] })],
    ["active", localItem({ active: 1 })],
    ["revision zero", localItem({ expectedRevision: 0 })],
    ["revision unsafe", localItem({ expectedRevision: Number.MAX_SAFE_INTEGER + 1 })]
  ];
  for (const [name, row] of cases) {
    await t.test(name, () => {
      assert.throws(
        () => normalizeLocalMasterDataRow("local_items", row),
        (error) => exactMbtError(
          error,
          "MBT_LOCAL_ITEM_INPUT_INVALID",
          "The local item contains an unsupported or invalid field."
        )
      );
    });
  }
});

test("P3-F10 validator: material identity, text, boolean, and revision are normalized or rejected", async (t) => {
  const { normalizeLocalMasterDataRow } = await futureService();
  const input = material({ expectedRevision: 2 });
  const before = structuredClone(input);
  assert.deepEqual(normalizeLocalMasterDataRow("materials", input), {
    materialCode: "CLEAN_FILL",
    displayName: "Clean fill",
    description: "Synthetic material",
    active: true,
    expectedRevision: 2
  });
  assert.deepEqual(input, before);

  const cases = [
    ["row", null],
    ["field", material({ unsupported: true })],
    ["code", material({ materialCode: "1FILL" })],
    ["name", material({ displayName: "" })],
    ["description", material({ description: 4 })],
    ["active", material({ active: "true" })],
    ["revision", material({ expectedRevision: -1 })]
  ];
  for (const [name, row] of cases) {
    await t.test(name, () => {
      assert.throws(
        () => normalizeLocalMasterDataRow("materials", row),
        (error) => exactMbtError(error, "MBT_MASTER_INPUT_INVALID", "The material row is invalid.")
      );
    });
  }
});

test("P3-F10 validator: dump-site coordinates are paired, finite, bounded, and preserved as decimal text", async (t) => {
  const { normalizeLocalMasterDataRow } = await futureService();
  assert.deepEqual(normalizeLocalMasterDataRow("dump_sites", dumpSite({ expectedRevision: 3 })), {
    dumpSiteCode: "NORTH_DUMP",
    displayName: "North dump",
    addressLine1: "1 Test Road",
    addressLine2: "",
    city: "Toronto",
    region: "ON",
    postalCode: "M1M 1M1",
    countryCode: "CA",
    phone: "519-555-0100",
    latitude: "43.7000",
    longitude: "-79.4000",
    materialCode: "CLEAN_FILL",
    accepted: true,
    scaleTicketRequired: false,
    notes: "Receipt optional",
    active: true,
    expectedRevision: 3
  });
  const noCoordinates = normalizeLocalMasterDataRow("dump_sites", dumpSite({ latitude: null, longitude: null }));
  assert.equal(noCoordinates.latitude, null);
  assert.equal(noCoordinates.longitude, null);

  const cases = [
    ["row", []],
    ["field", dumpSite({ unexpected: true })],
    ["empty latitude", dumpSite({ latitude: "" })],
    ["NaN latitude", dumpSite({ latitude: "north" })],
    ["latitude low", dumpSite({ latitude: -90.1 })],
    ["latitude high", dumpSite({ latitude: 90.1 })],
    ["longitude low", dumpSite({ longitude: -180.1 })],
    ["longitude high", dumpSite({ longitude: 180.1 })],
    ["latitude only", dumpSite({ longitude: null })],
    ["longitude only", dumpSite({ latitude: null })],
    ["country length", dumpSite({ countryCode: "CAN" })],
    ["country grammar", dumpSite({ countryCode: "C1" })],
    ["accepted", dumpSite({ accepted: "yes" })],
    ["ticket", dumpSite({ scaleTicketRequired: 1 })],
    ["revision", dumpSite({ expectedRevision: 0 })]
  ];
  for (const [name, row] of cases) {
    await t.test(name, () => {
      assert.throws(
        () => normalizeLocalMasterDataRow("dump_sites", row),
        (error) => exactMbtError(error, "MBT_MASTER_INPUT_INVALID", "The dump-site row is invalid.")
      );
    });
  }
});

test("P3-F10 validator: service-template steps and evidence normalize order, defaults, and casing", async () => {
  const { normalizeLocalMasterDataRow } = await futureService();
  const input = serviceTemplate({
    expectedRevision: 4,
    steps: [
      step({
        sequenceNumber: 2,
        actionCode: "DUMP_BIN",
        displayName: "Dump bin",
        stopKind: "DUMP",
        locationRole: "DUMP_SITE",
        requiredAssetStatusBefore: "ON_TRUCK",
        requiredAssetStatusAfter: null,
        dumpSiteRequired: true
      }),
      step()
    ],
    evidenceRequirements: [
      evidence({
        stepActionCode: "DUMP_BIN",
        evidenceCode: "WEIGHT",
        evidenceType: "WEIGHT",
        minimumCount: 2,
        description: " Scale weight "
      }),
      evidence()
    ]
  });
  const before = structuredClone(input);
  const normalized = normalizeLocalMasterDataRow("service_templates", input);

  assert.deepEqual(normalized.steps, [
    {
      sequenceNumber: 1,
      actionCode: "pickup_bin",
      displayName: "Pick up bin",
      stopKind: "pickup",
      locationRole: "customer_site",
      requiredAssetStatusBefore: null,
      requiredAssetStatusAfter: "on_truck",
      dumpSiteRequired: false,
      required: true
    },
    {
      sequenceNumber: 2,
      actionCode: "dump_bin",
      displayName: "Dump bin",
      stopKind: "dump",
      locationRole: "dump_site",
      requiredAssetStatusBefore: "on_truck",
      requiredAssetStatusAfter: null,
      dumpSiteRequired: true,
      required: true
    }
  ]);
  assert.deepEqual(normalized.evidenceRequirements, [
    {
      stepActionCode: "dump_bin",
      evidenceCode: "weight",
      evidenceType: "weight",
      minimumCount: 2,
      required: true,
      description: "Scale weight"
    },
    {
      stepActionCode: "pickup_bin",
      evidenceCode: "pickup_photo",
      evidenceType: "photo",
      minimumCount: 1,
      required: true,
      description: ""
    }
  ]);
  assert.equal(normalized.templateCode, "BIN_DELIVERY");
  assert.equal(normalized.expectedRevision, 4);
  assert.deepEqual(input, before);
});

test("P3-F10 validator: malformed service-template graph evidence fails closed", async (t) => {
  const { normalizeLocalMasterDataRow } = await futureService();
  const cases = [
    ["row", null],
    ["field", serviceTemplate({ unknown: true })],
    ["version", serviceTemplate({ versionNumber: 0 })],
    ["fractional version", serviceTemplate({ versionNumber: 1.5 })],
    ["status", serviceTemplate({ status: "published" })],
    ["empty steps", serviceTemplate({ steps: [] })],
    ["steps collection", serviceTemplate({ steps: {} })],
    ["step row", serviceTemplate({ steps: [null] })],
    ["step field", serviceTemplate({ steps: [step({ unexpected: true })] })],
    ["step sequence", serviceTemplate({ steps: [step({ sequenceNumber: -1 })] })],
    ["step fractional sequence", serviceTemplate({ steps: [step({ sequenceNumber: 1.5 })] })],
    ["step status before", serviceTemplate({ steps: [step({ requiredAssetStatusBefore: 7 })] })],
    ["step status after", serviceTemplate({ steps: [step({ requiredAssetStatusAfter: "" })] })],
    ["step dump flag", serviceTemplate({ steps: [step({ dumpSiteRequired: "false" })] })],
    ["step required", serviceTemplate({ steps: [step({ required: 1 })] })],
    ["duplicate sequence", serviceTemplate({ steps: [step(), step({ actionCode: "other" })] })],
    ["duplicate action", serviceTemplate({ steps: [step(), step({ sequenceNumber: 2 })] })],
    ["empty evidence", serviceTemplate({ evidenceRequirements: [] })],
    ["evidence collection", serviceTemplate({ evidenceRequirements: {} })],
    ["evidence row", serviceTemplate({ evidenceRequirements: [null] })],
    ["evidence field", serviceTemplate({ evidenceRequirements: [evidence({ unexpected: true })] })],
    ["evidence action", serviceTemplate({ evidenceRequirements: [evidence({ stepActionCode: "missing" })] })],
    ["evidence count zero", serviceTemplate({ evidenceRequirements: [evidence({ minimumCount: 0 })] })],
    ["evidence fractional count", serviceTemplate({ evidenceRequirements: [evidence({ minimumCount: 1.5 })] })],
    ["evidence type", serviceTemplate({ evidenceRequirements: [evidence({ evidenceType: "video" })] })],
    ["evidence required", serviceTemplate({ evidenceRequirements: [evidence({ required: "true" })] })],
    ["evidence description", serviceTemplate({ evidenceRequirements: [evidence({ description: null })] })],
    ["duplicate evidence", serviceTemplate({ evidenceRequirements: [evidence(), evidence()] })],
    ["active", serviceTemplate({ active: 1 })],
    ["bin service", serviceTemplate({ requiredBinService: "yes" })],
    ["dump site", serviceTemplate({ dumpSiteRequired: 0 })],
    ["revision", serviceTemplate({ expectedRevision: 0 })]
  ];
  for (const [name, row] of cases) {
    await t.test(name, () => {
      assert.throws(
        () => normalizeLocalMasterDataRow("service_templates", row),
        (error) => exactMbtError(error, "MBT_MASTER_INPUT_INVALID", "The service-template row is invalid.")
      );
    });
  }
});

test("P3-F09 validator: unsupported resource fails without mutating the supplied row", async () => {
  const { normalizeLocalMasterDataRow } = await futureService();
  const input = { value: "evidence" };
  const before = structuredClone(input);
  assert.throws(
    () => normalizeLocalMasterDataRow("customers", input),
    (error) => exactMbtError(
      error,
      "MBT_MASTER_INPUT_INVALID",
      "The local master-data resource is unsupported."
    )
  );
  assert.deepEqual(input, before);
});
