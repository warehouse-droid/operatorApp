// @ts-check

import assert from "node:assert/strict";
import crypto from "node:crypto";
import test, { after } from "node:test";

import { config } from "../../../src/config.js";
import { beginRollbackContext, closeDb, query } from "../../../src/db.js";
import {
  applyLocalMasterDataRows,
  listLocalMasterData
} from "../../../src/mbt/local-master-data-service.js";

const RUN_ID = crypto.randomUUID().replaceAll("-", "").toUpperCase();
const ACTOR = Object.freeze({
  operatorId: `p3-local-boundary-${RUN_ID}`,
  roles: Object.freeze(["admin"])
});
let commandSequence = 0;

after(async () => {
  await closeDb();
});

/** @param {() => Promise<unknown>} operation */
async function inRollback(operation) {
  const rollback = await beginRollbackContext();
  try {
    return await rollback.run(operation);
  } finally {
    await rollback.rollback();
  }
}

/** @param {object} options */
async function configureGate({
  environmentRoot = true,
  environmentMaster = true,
  databaseRoot = true,
  databaseMaster = true
} = {}) {
  config.mbt.enabled = environmentRoot;
  config.mbtPhase3.masterDataEnabled = environmentMaster;
  await query(
    `UPDATE mbt_feature_flags
        SET enabled = CASE flag_key
          WHEN 'mbt_enabled' THEN $1
          WHEN 'mbt_master_data' THEN $2
          ELSE enabled
        END,
        updated_by = $3,
        updated_at = now()
      WHERE flag_key = ANY($4::text[])`,
    [databaseRoot, databaseMaster, ACTOR.operatorId, ["mbt_enabled", "mbt_master_data"]]
  );
}

/** @param {string} resource @param {unknown[]} rows @param {object} [overrides] */
function command(resource, rows, overrides = {}) {
  commandSequence += 1;
  const marker = `${RUN_ID}-${commandSequence}`;
  return {
    actor: ACTOR,
    resource,
    sourceKind: "manual",
    rows,
    reason: `P3 local master boundary ${marker}`,
    idempotencyKey: `p3-local-boundary-idem-${marker}`,
    correlationId: `p3-local-boundary-corr-${marker}`,
    requestId: `p3-local-boundary-req-${marker}`,
    ...overrides
  };
}

/** @param {string} code @param {object} [overrides] */
function material(code, overrides = {}) {
  return {
    materialCode: code,
    displayName: `Material ${code}`,
    description: "Synthetic rollback-only evidence",
    active: true,
    ...overrides
  };
}

/** @param {string} code @param {string} materialCode @param {object} [overrides] */
function dumpSite(code, materialCode, overrides = {}) {
  return {
    dumpSiteCode: code,
    displayName: `Dump ${code}`,
    addressLine1: "1 Boundary Road",
    addressLine2: "Unit T",
    city: "Toronto",
    region: "ON",
    postalCode: "M1M 1M1",
    countryCode: "CA",
    phone: "519-555-0100",
    latitude: "43.7000",
    longitude: "-79.4000",
    materialCode,
    accepted: true,
    scaleTicketRequired: true,
    notes: "Scale receipt required",
    active: true,
    ...overrides
  };
}

/** @param {string} code @param {object} [overrides] */
function template(code, overrides = {}) {
  return {
    templateCode: code,
    displayName: `Template ${code}`,
    description: "Synthetic service template",
    active: true,
    versionNumber: 1,
    status: "draft",
    requiredBinService: true,
    dumpSiteRequired: false,
    steps: [{
      sequenceNumber: 1,
      actionCode: "deliver_bin",
      displayName: "Deliver bin",
      stopKind: "drop",
      locationRole: "customer_site",
      requiredAssetStatusBefore: "on_truck",
      requiredAssetStatusAfter: "at_customer",
      required: true
    }],
    evidenceRequirements: [{
      stepActionCode: "deliver_bin",
      evidenceCode: "delivery_photo",
      evidenceType: "photo",
      minimumCount: 1,
      required: true
    }],
    ...overrides
  };
}

/** @param {unknown} error @param {string} code @param {number} status */
function exactError(error, code, status) {
  return Boolean(error && typeof error === "object"
    && error.name === "MbtError"
    && error.code === code
    && error.status === status);
}

test("P3-F09 service: command shape and duplicate natural identities fail before gate or writes", async () => {
  await inRollback(async () => {
    await configureGate();
    const before = await query("SELECT count(*)::int AS count FROM mbt_materials");
    const invalidCommands = [
      command("materials", []),
      command("materials", [material("BAD_SOURCE")], { sourceKind: "api" }),
      command("materials", [material("BLANK_REASON")], { reason: "   " })
    ];
    for (const input of invalidCommands) {
      await assert.rejects(
        applyLocalMasterDataRows(input),
        (error) => exactError(error, "MBT_MASTER_INPUT_INVALID", 400)
      );
    }
    await assert.rejects(
      applyLocalMasterDataRows(command("materials", [
        material("DUPLICATE"),
        material(" duplicate ")
      ])),
      (error) => exactError(error, "MBT_MASTER_INPUT_INVALID", 400)
    );
    assert.deepEqual(await query("SELECT count(*)::int AS count FROM mbt_materials"), before);
  });
});

test("P3-F09 service: every master-data gate denial is explicit and side-effect free", async (t) => {
  await inRollback(async () => {
    const codePrefix = `GATE_${RUN_ID.slice(0, 8)}`;
    const cases = [
      ["environment root", { environmentRoot: false }, ACTOR, "environment_root_disabled"],
      ["database root", { databaseRoot: false }, ACTOR, "database_root_disabled"],
      ["environment capability", { environmentMaster: false }, ACTOR, "environment_capability_disabled"],
      ["database capability", { databaseMaster: false }, ACTOR, "database_capability_disabled"],
      ["pilot scope", {}, { operatorId: `${ACTOR.operatorId}-dispatcher`, roles: ["dispatcher"] }, "pilot_scope_denied"]
    ];
    for (const [name, gate, actor, reason] of cases) {
      await t.test(name, async () => {
        await configureGate(gate);
        const materialCode = `${codePrefix}_${String(name).replaceAll(" ", "_").toUpperCase()}`;
        await assert.rejects(
          applyLocalMasterDataRows(command("materials", [material(materialCode)], { actor })),
          (error) => exactError(error, "MBT_CAPABILITY_DISABLED", 409)
            && error.details?.capability === "master_data"
            && error.details?.reason === reason
        );
        assert.equal((await query(
          "SELECT count(*)::int AS count FROM mbt_materials WHERE material_code = $1",
          [materialCode]
        )).rows[0].count, 0);
      });
    }
  });
});

test("P3-F09 service: create/update/list return stable public DTOs for every local resource", async () => {
  await inRollback(async () => {
    await configureGate();
    const suffix = RUN_ID.slice(0, 8);
    const materialCode = `MAT_${suffix}`;
    const itemCode = `ITEM_${suffix}`;
    const siteCode = `SITE_${suffix}`;
    const templateCode = `TPL_${suffix}`;

    const materialCreated = await applyLocalMasterDataRows(command("materials", [material(materialCode)]));
    assert.equal(materialCreated.replayed, false);
    assert.equal(materialCreated.status, 200);
    assert.deepEqual({
      created: materialCreated.body.created,
      updated: materialCreated.body.updated,
      code: materialCreated.body.entities[0].material_code,
      revision: materialCreated.body.entities[0].revision
    }, { created: 1, updated: 0, code: materialCode, revision: 1 });
    const materialUpdated = await applyLocalMasterDataRows(command("materials", [material(materialCode, {
      displayName: "Updated material",
      active: true,
      expectedRevision: 1
    })]));
    assert.deepEqual({
      created: materialUpdated.body.created,
      updated: materialUpdated.body.updated,
      displayName: materialUpdated.body.entities[0].display_name,
      active: materialUpdated.body.entities[0].active,
      revision: materialUpdated.body.entities[0].revision
    }, { created: 0, updated: 1, displayName: "Updated material", active: true, revision: 2 });

    const itemBase = {
      itemCode,
      displayName: "Boundary service item",
      description: "Local-only identity",
      category: "service",
      pricingMode: "custom_price",
      applicableServiceTypes: ["delivery"],
      applicableLegacySourceTypes: ["SO"],
      binTypeCode: "14YD",
      netSuiteMappingLocalKey: null,
      active: true
    };
    const itemCreated = await applyLocalMasterDataRows(command("local_items", [itemBase]));
    assert.deepEqual({
      created: itemCreated.body.created,
      code: itemCreated.body.entities[0].itemCode,
      binType: itemCreated.body.entities[0].binTypeCode,
      mapping: itemCreated.body.entities[0].netSuiteMappingLocalKey,
      systemOwned: itemCreated.body.entities[0].systemOwned
    }, { created: 1, code: itemCode, binType: null, mapping: null, systemOwned: false });
    const itemUpdated = await applyLocalMasterDataRows(command("local_items", [{
      ...itemBase,
      displayName: "Updated boundary service item",
      expectedRevision: 1
    }]));
    assert.deepEqual({
      created: itemUpdated.body.created,
      updated: itemUpdated.body.updated,
      displayName: itemUpdated.body.entities[0].displayName,
      revision: itemUpdated.body.entities[0].revision
    }, { created: 0, updated: 1, displayName: "Updated boundary service item", revision: 2 });

    const siteCreated = await applyLocalMasterDataRows(command("dump_sites", [dumpSite(siteCode, materialCode)]));
    assert.equal(siteCreated.body.created, 1);
    const siteUpdated = await applyLocalMasterDataRows(command("dump_sites", [dumpSite(siteCode, materialCode, {
      displayName: "Updated dump site",
      accepted: false,
      scaleTicketRequired: false,
      expectedRevision: 1
    })]));
    assert.deepEqual({
      created: siteUpdated.body.created,
      updated: siteUpdated.body.updated,
      displayName: siteUpdated.body.entities[0].displayName,
      revision: siteUpdated.body.entities[0].revision
    }, { created: 0, updated: 1, displayName: "Updated dump site", revision: 2 });

    const templateCreated = await applyLocalMasterDataRows(command("service_templates", [template(templateCode)]));
    assert.equal(templateCreated.body.created, 1);
    const templateUpdated = await applyLocalMasterDataRows(command("service_templates", [template(templateCode, {
      displayName: "Updated template",
      active: false,
      expectedRevision: 1
    })]));
    assert.deepEqual({
      created: templateUpdated.body.created,
      updated: templateUpdated.body.updated,
      displayName: templateUpdated.body.entities[0].display_name,
      active: templateUpdated.body.entities[0].active,
      revision: templateUpdated.body.entities[0].revision
    }, { created: 0, updated: 1, displayName: "Updated template", active: false, revision: 2 });

    const items = await listLocalMasterData("local_items");
    const materials = await listLocalMasterData("materials");
    const sites = await listLocalMasterData("dump_sites");
    const templates = await listLocalMasterData("service_templates");
    const listedItem = items.entities.find(({ itemCode: code }) => code === itemCode);
    const listedMaterial = materials.entities.find(({ materialCode: code }) => code === materialCode);
    const listedSite = sites.entities.find(({ dumpSiteCode: code }) => code === siteCode);
    const listedTemplate = templates.entities.find(({ templateCode: code }) => code === templateCode);

    assert.deepEqual({
      resource: items.resource,
      displayName: listedItem.displayName,
      category: listedItem.category,
      priceMode: listedItem.priceMode,
      serviceTypes: listedItem.applicableServiceTypes,
      legacyTypes: listedItem.applicableLegacySourceTypes,
      binTypeCode: listedItem.binTypeCode,
      active: listedItem.active,
      revision: listedItem.revision
    }, {
      resource: "local_items",
      displayName: "Updated boundary service item",
      category: "service",
      priceMode: "custom_price",
      serviceTypes: ["delivery"],
      legacyTypes: ["SO"],
      binTypeCode: null,
      active: true,
      revision: 2
    });
    assert.deepEqual({
      resource: materials.resource,
      materialCode: listedMaterial.materialCode,
      displayName: listedMaterial.displayName,
      description: listedMaterial.description,
      active: listedMaterial.active,
      revision: listedMaterial.revision
    }, {
      resource: "materials",
      materialCode,
      displayName: "Updated material",
      description: "Synthetic rollback-only evidence",
      active: true,
      revision: 2
    });
    assert.match(listedMaterial.materialId, /^[0-9a-f-]{36}$/u);
    assert.match(listedMaterial.createdAt, /^\d{4}-\d{2}-\d{2}T/u);
    assert.match(listedMaterial.updatedAt, /^\d{4}-\d{2}-\d{2}T/u);
    assert.deepEqual({
      resource: sites.resource,
      code: listedSite.dumpSiteCode,
      displayName: listedSite.displayName,
      addressLine2: listedSite.addressLine2,
      coordinates: [listedSite.latitude, listedSite.longitude],
      active: listedSite.active,
      revision: listedSite.revision,
      materials: listedSite.materials.map((entry) => ({
        materialCode: entry.materialCode,
        accepted: entry.accepted,
        scaleTicketRequired: entry.scaleTicketRequired,
        active: entry.active,
        revision: entry.revision
      }))
    }, {
      resource: "dump_sites",
      code: siteCode,
      displayName: "Updated dump site",
      addressLine2: "Unit T",
      coordinates: ["43.7000", "-79.4000"],
      active: true,
      revision: 2,
      materials: [{
        materialCode,
        accepted: false,
        scaleTicketRequired: false,
        active: true,
        revision: 2
      }]
    });
    assert.deepEqual({
      resource: templates.resource,
      code: listedTemplate.templateCode,
      displayName: listedTemplate.displayName,
      active: listedTemplate.active,
      revision: listedTemplate.revision,
      versions: listedTemplate.versions.map((version) => ({
        versionNumber: version.versionNumber,
        status: version.status,
        requiredBinService: version.requiredBinService,
        dumpSiteRequired: version.dumpSiteRequired,
        revision: version.revision
      }))
    }, {
      resource: "service_templates",
      code: templateCode,
      displayName: "Updated template",
      active: false,
      revision: 2,
      versions: [{
        versionNumber: 1,
        status: "draft",
        requiredBinService: true,
        dumpSiteRequired: false,
        revision: 1
      }]
    });

    await assert.rejects(
      listLocalMasterData("customers"),
      (error) => exactError(error, "MBT_MASTER_INPUT_INVALID", 400)
    );
  });
});

test("P3-F09 service: references and revisions fail atomically with no receipts or partial rows", async () => {
  await inRollback(async () => {
    await configureGate();
    const suffix = RUN_ID.slice(8, 16);
    const existingCode = `EXIST_${suffix}`;
    const partialCode = `PARTIAL_${suffix}`;
    const missingBinCode = `BINREF_${suffix}`;
    const missingSiteCode = `SITEREF_${suffix}`;
    await applyLocalMasterDataRows(command("materials", [material(existingCode)]));

    const atomic = command("materials", [
      material(partialCode),
      material(existingCode, { displayName: "Must not win", expectedRevision: 99 })
    ]);
    await assert.rejects(
      applyLocalMasterDataRows(atomic),
      (error) => exactError(error, "MBT_STALE_REVISION", 409)
    );
    assert.equal((await query(
      "SELECT count(*)::int AS count FROM mbt_materials WHERE material_code = $1",
      [partialCode]
    )).rows[0].count, 0);
    assert.deepEqual((await query(
      "SELECT display_name, revision::int FROM mbt_materials WHERE material_code = $1",
      [existingCode]
    )).rows, [{ display_name: `Material ${existingCode}`, revision: 1 }]);
    assert.equal((await query(
      `SELECT count(*)::int AS count
         FROM mbt_command_receipts
        WHERE actor_operator_id = $1 AND command_name = 'mbt.local_master.materials.apply'
          AND idempotency_key = $2`,
      [ACTOR.operatorId, atomic.idempotencyKey]
    )).rows[0].count, 0);

    await assert.rejects(
      applyLocalMasterDataRows(command("materials", [material(existingCode, { expectedRevision: undefined })])),
      (error) => exactError(error, "MBT_MASTER_INPUT_INVALID", 400)
    );

    const missingBin = command("local_items", [{
      itemCode: missingBinCode,
      displayName: "Missing bin reference",
      description: "Must roll back",
      itemType: "bin",
      rentalPeriodDays: 14,
      applicableServiceTypes: [],
      applicableLegacySourceTypes: [],
      binTypeCode: "DOES_NOT_EXIST",
      active: true
    }]);
    await assert.rejects(
      applyLocalMasterDataRows(missingBin),
      (error) => exactError(error, "MBT_MASTER_REFERENCE_INVALID", 400)
        && error.message === "The local item BIN type is unavailable."
    );
    assert.equal((await query(
      "SELECT count(*)::int AS count FROM mbt_local_item_settings WHERE item_code = $1",
      [missingBinCode]
    )).rows[0].count, 0);

    const missingMaterial = command("dump_sites", [dumpSite(missingSiteCode, "DOES_NOT_EXIST")]);
    await assert.rejects(
      applyLocalMasterDataRows(missingMaterial),
      (error) => exactError(error, "MBT_MASTER_REFERENCE_INVALID", 400)
        && error.message === "One or more dump-site items are unavailable."
    );
    assert.equal((await query(
      "SELECT count(*)::int AS count FROM mbt_dump_sites WHERE dump_site_code = $1",
      [missingSiteCode]
    )).rows[0].count, 0);
    assert.equal((await query(
      `SELECT count(*)::int AS count FROM mbt_command_receipts
        WHERE idempotency_key = ANY($1::text[])`,
      [[missingBin.idempotencyKey, missingMaterial.idempotencyKey]]
    )).rows[0].count, 0);
  });
});

test("P3-F09 service: a protected item may change presentation but never operational identity", async () => {
  await inRollback(async () => {
    await configureGate();
    const protectedItem = (await listLocalMasterData("local_items")).entities
      .find(({ itemCode }) => itemCode === "14YD");
    assert.ok(protectedItem);
    const common = {
      itemCode: protectedItem.itemCode,
      displayName: "14 yard bin charge boundary",
      description: "Presentation-only update",
      category: protectedItem.category,
      pricingMode: protectedItem.priceMode,
      applicableServiceTypes: protectedItem.applicableServiceTypes,
      applicableLegacySourceTypes: protectedItem.applicableLegacySourceTypes,
      binTypeCode: protectedItem.binTypeCode,
      netSuiteMappingLocalKey: protectedItem.netSuiteMappingLocalKey,
      active: protectedItem.active,
      expectedRevision: protectedItem.revision
    };
    const updated = await applyLocalMasterDataRows(command("local_items", [common]));
    assert.equal(updated.body.updated, 1);
    assert.equal(updated.body.entities[0].displayName, "14 yard bin charge boundary");
    assert.equal(updated.body.entities[0].revision, protectedItem.revision + 1);

    await assert.rejects(
      applyLocalMasterDataRows(command("local_items", [{
        ...common,
        displayName: "Identity mutation",
        category: "discount",
        expectedRevision: protectedItem.revision + 1
      }])),
      (error) => exactError(error, "MBT_PROTECTED_LOCAL_ITEM_IDENTITY", 409)
    );
    const retained = (await listLocalMasterData("local_items")).entities
      .find(({ itemCode }) => itemCode === "14YD");
    assert.equal(retained.category, protectedItem.category);
    assert.equal(retained.displayName, "14 yard bin charge boundary");
    assert.equal(retained.revision, protectedItem.revision + 1);
  });
});
