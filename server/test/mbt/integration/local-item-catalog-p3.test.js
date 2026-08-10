// @ts-check

import assert from "node:assert/strict";
import crypto from "node:crypto";
import test, { after } from "node:test";

import express from "express";

import { config } from "../../../src/config.js";
import { beginRollbackContext, closeDb, query } from "../../../src/db.js";
import { createMbtRouter } from "../../../src/mbt/router.js";
import { listMbtLocalItemSettings } from "../../../src/mbt/local-item-settings-repository.js";

const RUN_ID = crypto.randomUUID().replaceAll("-", "").toUpperCase();
const ACTOR = Object.freeze({
  operatorId: `p3-master-admin-${RUN_ID}`,
  roles: Object.freeze(["admin"])
});
const PROTECTED_CODES = Object.freeze([
  "DELIVERY_CROSS_CHARGE",
  "14YD",
  "20YD",
  "40YD",
  "DUMP"
]);
let commandSequence = 0;
let localMasterModulePromise;

after(async () => {
  await closeDb();
});

async function localMasterService() {
  localMasterModulePromise ||= import("../../../src/mbt/local-master-data-service.js").catch((error) => ({ importError: error }));
  const service = await localMasterModulePromise;
  assert.equal(
    service.importError,
    undefined,
    `P3.4 requires local-master-data-service.js: ${service.importError?.message || "missing"}`
  );
  assert.equal(typeof service.normalizeLocalMasterDataRow, "function");
  assert.equal(typeof service.applyLocalMasterDataRows, "function");
  assert.equal(typeof service.listLocalMasterData, "function");
  return service;
}

async function inRollback(fn) {
  const rollback = await beginRollbackContext();
  try {
    return await rollback.run(fn);
  } finally {
    await rollback.rollback();
  }
}

async function withMasterDataEnabled(fn) {
  const environmentBefore = {
    root: config.mbt.enabled,
    capability: config.mbtPhase3.masterDataEnabled
  };
  config.mbt.enabled = true;
  config.mbtPhase3.masterDataEnabled = true;
  await query(
    `UPDATE mbt_feature_flags
        SET enabled = true,
            updated_by = $2,
            updated_at = now()
      WHERE flag_key = ANY($1::text[])`,
    [["mbt_enabled", "mbt_master_data"], ACTOR.operatorId]
  );
  try {
    return await fn();
  } finally {
    config.mbt.enabled = environmentBefore.root;
    config.mbtPhase3.masterDataEnabled = environmentBefore.capability;
  }
}

function applyInput(resource, sourceKind, rows, label) {
  commandSequence += 1;
  const identity = `${RUN_ID}-${commandSequence}`;
  return {
    actor: ACTOR,
    resource,
    sourceKind,
    rows,
    reason: `P3 local master ${label}`,
    idempotencyKey: `p3-local-master-idem-${identity}`,
    correlationId: `p3-local-master-corr-${identity}`,
    requestId: `p3-local-master-req-${identity}`
  };
}

test("P3-F09: the protected five become system-owned rows while the catalog permits custom identity", async () => {
  const schema = await query(
    `SELECT column_name, is_nullable
       FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'mbt_local_item_settings'
      ORDER BY ordinal_position`
  );
  const columns = new Map(schema.rows.map((column) => [column.column_name, column]));
  assert.equal(columns.get("system_owned")?.is_nullable, "NO");
  assert.equal(columns.get("netsuite_mapping_local_key")?.is_nullable, "YES");
  for (const forbidden of [
    "amount", "amount_minor", "currency", "price", "price_minor", "uom", "unit_of_measure"
  ]) {
    assert.equal(columns.has(forbidden), false, `Local item identity must not own ${forbidden}.`);
  }

  const constraints = await query(
    `SELECT pg_get_constraintdef(oid) AS definition
       FROM pg_constraint
      WHERE conrelid = 'mbt_local_item_settings'::regclass
      ORDER BY conname`
  );
  const definitions = constraints.rows.map(({ definition }) => definition).join("\n");
  for (const category of [
    "bin_charge", "dump", "service", "surcharge", "discount", "cross_charge", "other"
  ]) {
    assert.match(definitions, new RegExp(`'${category}'`));
  }
  assert.doesNotMatch(definitions, /item_code\s+IN\s*\(\s*'DELIVERY_CROSS_CHARGE'/i);

  const items = await listMbtLocalItemSettings();
  assert.deepEqual(
    items.filter(({ systemOwned }) => systemOwned).map(({ itemCode }) => itemCode),
    PROTECTED_CODES
  );
  assert.ok(items.filter(({ itemCode }) => PROTECTED_CODES.includes(itemCode)).every((item) => (
    item.systemOwned === true && item.revision >= 1
  )));
});

test("P3-F09: manual and CSV custom items use one validator, normalize uppercase, and replay exactly", async () => {
  await inRollback(() => withMasterDataEnabled(async () => {
    const service = await localMasterService();
    const manualRow = {
      itemCode: " bin_wash ",
      displayName: "Bin wash",
      description: "Local cleaning service",
      itemType: "surcharge",
      rentalPeriodDays: null,
      applicableServiceTypes: ["exchange"],
      applicableLegacySourceTypes: [],
      binTypeCode: null,
      active: true
    };
    const csvRow = {
      itemCode: "env_fee",
      displayName: "Environmental fee",
      description: "Locally configured delivery fee",
      itemType: "delivery_fee",
      rentalPeriodDays: null,
      applicableServiceTypes: ["delivery", "final_pickup"],
      applicableLegacySourceTypes: [],
      binTypeCode: null,
      active: true
    };
    assert.deepEqual(
      service.normalizeLocalMasterDataRow("local_items", manualRow),
      {
        ...manualRow,
        itemCode: "BIN_WASH",
        chargeBasis: "per_event",
        densityLbsPerYard: null,
        category: "surcharge",
        pricingMode: "custom_price"
      }
    );
    assert.deepEqual(
      service.normalizeLocalMasterDataRow("local_items", csvRow),
      {
        ...csvRow,
        itemCode: "ENV_FEE",
        chargeBasis: "distance",
        densityLbsPerYard: null,
        category: "service",
        pricingMode: "rate_card"
      }
    );

    const manualInput = applyInput("local_items", "manual", [manualRow], "manual custom item");
    const manual = await service.applyLocalMasterDataRows(manualInput);
    const replay = await service.applyLocalMasterDataRows(structuredClone(manualInput));
    const csv = await service.applyLocalMasterDataRows(
      applyInput("local_items", "csv", [csvRow], "CSV custom item")
    );
    assert.equal(manual.replayed, false);
    assert.equal(replay.replayed, true);
    assert.deepEqual(replay.body, manual.body);
    assert.equal(csv.replayed, false);

    const custom = (await listMbtLocalItemSettings())
      .filter(({ itemCode }) => ["BIN_WASH", "ENV_FEE"].includes(itemCode));
    assert.deepEqual(custom.map((item) => ({
      itemCode: item.itemCode,
      systemOwned: item.systemOwned,
      itemType: item.itemType,
      rentalPeriodDays: item.rentalPeriodDays,
      category: item.category,
      priceMode: item.priceMode,
      binTypeCode: item.binTypeCode,
      netSuiteMappingLocalKey: item.netSuiteMappingLocalKey,
      netSuite: item.netSuite,
      active: item.active
    })), [
      {
        itemCode: "BIN_WASH",
        systemOwned: false,
        itemType: "surcharge",
        rentalPeriodDays: null,
        category: "surcharge",
        priceMode: "custom_price",
        binTypeCode: null,
        netSuiteMappingLocalKey: null,
        netSuite: null,
        active: true
      },
      {
        itemCode: "ENV_FEE",
        systemOwned: false,
        itemType: "delivery_fee",
        rentalPeriodDays: null,
        category: "service",
        priceMode: "rate_card",
        binTypeCode: null,
        netSuiteMappingLocalKey: null,
        netSuite: null,
        active: true
      }
    ]);
    assert.ok(custom.every((item) => (
      !Object.hasOwn(item, "amount")
        && !Object.hasOwn(item, "currency")
        && !Object.hasOwn(item, "price")
        && !Object.hasOwn(item, "uom")
        && !Object.hasOwn(item, "unitOfMeasure")
    )));
  }));
});

test("P3-F09: manual and CSV paths reject the same forbidden pricing/UOM/currency fields", async () => {
  await inRollback(() => withMasterDataEnabled(async () => {
    const service = await localMasterService();
    const forbidden = {
      itemCode: "FORBIDDEN_PRICE",
      displayName: "Forbidden duplicate pricing",
      description: "Must not persist",
      category: "other",
      pricingMode: "custom_price",
      applicableServiceTypes: [],
      applicableLegacySourceTypes: [],
      binTypeCode: null,
      active: true,
      amountMinor: 1,
      currency: "CAD",
      unitOfMeasure: "EA",
      netSuiteItemId: 3637
    };
    for (const sourceKind of ["manual", "csv"]) {
      await assert.rejects(
        () => service.applyLocalMasterDataRows(
          applyInput("local_items", sourceKind, [forbidden], `${sourceKind} forbidden duplicate pricing`)
        ),
        (error) => error?.status === 400 && error?.code === "MBT_LOCAL_ITEM_INPUT_INVALID"
      );
    }
    const stored = await query(
      "SELECT item_code FROM mbt_local_item_settings WHERE item_code = 'FORBIDDEN_PRICE'"
    );
    assert.equal(stored.rowCount, 0);

    const protected14 = (await listMbtLocalItemSettings()).find(({ itemCode }) => itemCode === "14YD");
    assert.ok(protected14);
    await assert.rejects(
      () => service.applyLocalMasterDataRows(applyInput("local_items", "manual", [{
        itemCode: "14YD",
        displayName: protected14.displayName,
        description: protected14.description,
        itemType: "surcharge",
        rentalPeriodDays: null,
        applicableServiceTypes: [],
        applicableLegacySourceTypes: [],
        binTypeCode: null,
        active: true,
        expectedRevision: protected14.revision
      }], "protected identity mutation")),
      (error) => error?.status === 409 && error?.code === "MBT_PROTECTED_LOCAL_ITEM_IDENTITY"
    );
  }));
});

test("P3-F10: material, dump acceptance, and versioned template setup validate references and retain inactivation history", async () => {
  await inRollback(() => withMasterDataEnabled(async () => {
    const service = await localMasterService();
    const materialCode = `CLEAN_FILL_${RUN_ID.slice(0, 8)}`;
    const siteCode = `DUMP_${RUN_ID.slice(0, 8)}`;
    const templateCode = `LOADED_RETURN_${RUN_ID.slice(0, 8)}`;

    await service.applyLocalMasterDataRows(applyInput("materials", "manual", [{
      materialCode,
      displayName: "Clean fill",
      description: "Synthetic P3 material",
      active: true
    }], "material create"));
    await service.applyLocalMasterDataRows(applyInput("dump_sites", "csv", [{
      dumpSiteCode: siteCode,
      displayName: "Synthetic transfer station",
      addressLine1: "1 Test Yard Road",
      addressLine2: "",
      city: "Toronto",
      region: "ON",
      postalCode: "M1M 1M1",
      countryCode: "CA",
      phone: "",
      latitude: "43.7000000",
      longitude: "-79.4000000",
      materialCode,
      accepted: true,
      scaleTicketRequired: true,
      notes: "Receipt required",
      active: true
    }], "dump and acceptance create"));

    const templateRow = {
      templateCode,
      displayName: "Loaded pickup, dump, and return",
      description: "Synthetic P3 service template",
      active: true,
      versionNumber: 1,
      status: "draft",
      requiredBinService: true,
      dumpSiteRequired: true,
      steps: [
        {
          sequenceNumber: 1,
          actionCode: "pickup_loaded_bin",
          displayName: "Pick up loaded bin",
          stopKind: "pickup",
          locationRole: "customer_site",
          requiredAssetStatusBefore: "at_customer",
          requiredAssetStatusAfter: "on_truck",
          required: true
        },
        {
          sequenceNumber: 2,
          actionCode: "dump_material",
          displayName: "Dump material",
          stopKind: "dump",
          locationRole: "dump_site",
          requiredAssetStatusBefore: "on_truck",
          requiredAssetStatusAfter: "on_truck",
          dumpSiteRequired: true,
          required: true
        },
        {
          sequenceNumber: 3,
          actionCode: "return_empty_bin",
          displayName: "Return empty bin",
          stopKind: "drop",
          locationRole: "own_yard",
          requiredAssetStatusBefore: "on_truck",
          requiredAssetStatusAfter: "available",
          required: true
        }
      ],
      evidenceRequirements: [
        { stepActionCode: "pickup_loaded_bin", evidenceCode: "pickup_scan", evidenceType: "bin_scan", minimumCount: 1, required: true },
        { stepActionCode: "dump_material", evidenceCode: "scale_ticket", evidenceType: "receipt", minimumCount: 1, required: true },
        { stepActionCode: "return_empty_bin", evidenceCode: "return_photo", evidenceType: "photo", minimumCount: 1, required: true }
      ]
    };
    await service.applyLocalMasterDataRows(
      applyInput("service_templates", "manual", [templateRow], "service template create")
    );

    const listedItems = await service.listLocalMasterData("local_items");
    const listedMaterials = await service.listLocalMasterData("materials");
    const listedSites = await service.listLocalMasterData("dump_sites");
    const listedTemplates = await service.listLocalMasterData("service_templates");
    assert.equal(listedItems.resource, "local_items");
    assert.ok(listedItems.entities.some(({ itemCode }) => itemCode === "14YD"));
    const listedMaterial = listedMaterials.entities.find(({ materialCode: code }) => code === materialCode);
    assert.ok(listedMaterial);
    assert.match(listedMaterial.materialId, /^[0-9a-f-]{36}$/u);
    assert.deepEqual({
      materialCode: listedMaterial.materialCode,
      displayName: listedMaterial.displayName,
      description: listedMaterial.description,
      active: listedMaterial.active,
      revision: listedMaterial.revision
    }, {
      materialCode,
      displayName: "Clean fill",
      description: "Synthetic P3 material",
      active: true,
      revision: 1
    });
    assert.match(listedMaterial.createdAt, /^\d{4}-\d{2}-\d{2}T/u);
    assert.match(listedMaterial.updatedAt, /^\d{4}-\d{2}-\d{2}T/u);
    const listedSite = listedSites.entities.find(({ dumpSiteCode: code }) => code === siteCode);
    assert.ok(listedSite);
    assert.equal(listedSite.addressLine2, "");
    assert.equal(listedSite.latitude, "43.7000000");
    assert.deepEqual(listedSite.materials.map((material) => ({
      materialCode: material.materialCode,
      accepted: material.accepted,
      scaleTicketRequired: material.scaleTicketRequired,
      active: material.active,
      revision: material.revision
    })), [{
      materialCode,
      accepted: true,
      scaleTicketRequired: true,
      active: true,
      revision: 1
    }]);
    const listedTemplate = listedTemplates.entities.find(({ templateCode: code }) => code === templateCode);
    assert.ok(listedTemplate);
    assert.equal(listedTemplate.description, "Synthetic P3 service template");
    assert.deepEqual(listedTemplate.versions.map((version) => ({
      versionNumber: version.versionNumber,
      status: version.status,
      requiredBinService: version.requiredBinService,
      dumpSiteRequired: version.dumpSiteRequired,
      revision: version.revision
    })), [{
      versionNumber: 1,
      status: "draft",
      requiredBinService: true,
      dumpSiteRequired: true,
      revision: 1
    }]);
    await assert.rejects(
      () => service.listLocalMasterData("unsupported"),
      (error) => error?.status === 400 && error?.code === "MBT_MASTER_INPUT_INVALID"
    );

    const stored = await query(
      `SELECT
         (SELECT jsonb_build_object(
           'active', material.active,
           'revision', material.revision::int
         ) FROM mbt_materials material WHERE material.material_code = $1) AS material,
         (SELECT jsonb_build_object(
           'active', site.active,
           'revision', site.revision::int,
           'latitude', site.latitude::text,
           'longitude', site.longitude::text
         ) FROM mbt_dump_sites site WHERE site.dump_site_code = $2) AS dump_site,
         (SELECT jsonb_build_object(
           'accepted', acceptance.accepted,
           'scaleTicketRequired', acceptance.scale_ticket_required,
           'active', acceptance.active
         )
            FROM mbt_dump_site_materials acceptance
            JOIN mbt_dump_sites site ON site.dump_site_id = acceptance.dump_site_id
            JOIN mbt_materials material ON material.material_id = acceptance.material_id
           WHERE site.dump_site_code = $2 AND material.material_code = $1) AS acceptance,
         (SELECT jsonb_build_object(
           'active', template.active,
           'revision', template.revision::int,
           'versionStatus', version.status,
           'steps', (SELECT count(*)::int FROM mbt_service_template_steps step
                      WHERE step.template_version_id = version.template_version_id),
           'evidence', (SELECT count(*)::int FROM mbt_service_template_evidence_requirements evidence
                         WHERE evidence.template_version_id = version.template_version_id)
         )
            FROM mbt_service_templates template
            JOIN mbt_service_template_versions version ON version.template_id = template.template_id
           WHERE template.template_code = $3 AND version.version_number = 1) AS template`,
      [materialCode, siteCode, templateCode]
    );
    assert.deepEqual(stored.rows[0], {
      material: { active: true, revision: 1 },
      dump_site: {
        active: true,
        revision: 1,
        latitude: "43.7000000",
        longitude: "-79.4000000"
      },
      acceptance: { accepted: true, scaleTicketRequired: true, active: true },
      template: { active: true, revision: 1, versionStatus: "draft", steps: 3, evidence: 3 }
    });

    await assert.rejects(
      () => service.applyLocalMasterDataRows(applyInput("dump_sites", "manual", [{
        dumpSiteCode: `${siteCode}_UNKNOWN`,
        displayName: "Unknown material site",
        addressLine1: "2 Test Yard Road",
        addressLine2: "",
        city: "Toronto",
        region: "ON",
        postalCode: "M1M 1M2",
        countryCode: "CA",
        phone: "",
        latitude: null,
        longitude: null,
        materialCode: "DOES_NOT_EXIST",
        accepted: true,
        scaleTicketRequired: true,
        notes: "Must roll back",
        active: true
      }], "unknown dump material")),
      (error) => error?.status === 400 && error?.code === "MBT_MASTER_REFERENCE_INVALID"
    );
    assert.equal((await query(
      "SELECT count(*)::int AS count FROM mbt_dump_sites WHERE dump_site_code = $1",
      [`${siteCode}_UNKNOWN`]
    )).rows[0].count, 0);

    await service.applyLocalMasterDataRows(applyInput("materials", "manual", [{
      materialCode,
      displayName: "Clean fill",
      description: "Synthetic P3 material",
      active: false,
      expectedRevision: 1
    }], "material inactivation"));
    await service.applyLocalMasterDataRows(applyInput("service_templates", "manual", [{
      ...templateRow,
      active: false,
      expectedRevision: 1
    }], "template inactivation"));

    const retained = await query(
      `SELECT
         (SELECT jsonb_build_object('active', active, 'revision', revision::int)
            FROM mbt_materials WHERE material_code = $1) AS material,
         (SELECT jsonb_build_object('active', active, 'revision', revision::int)
            FROM mbt_service_templates WHERE template_code = $2) AS template,
         (SELECT count(*)::int FROM mbt_audit_events
           WHERE actor_operator_id = $3
             AND before_state <> '{}'::jsonb
             AND after_state <> '{}'::jsonb) AS audit_snapshots`,
      [materialCode, templateCode, ACTOR.operatorId]
    );
    assert.deepEqual(retained.rows[0].material, { active: false, revision: 2 });
    assert.deepEqual(retained.rows[0].template, { active: false, revision: 2 });
    assert.ok(retained.rows[0].audit_snapshots >= 5, JSON.stringify(retained.rows[0]));
  }));
});

test("P3-F10: closed master-data gates reject setup API commands before domain or transport effects", async () => {
  await inRollback(async () => {
    const environmentBefore = {
      root: config.mbt.enabled,
      capability: config.mbtPhase3.masterDataEnabled
    };
    await query(
      "UPDATE mbt_feature_flags SET enabled = false WHERE flag_key = ANY($1::text[])",
      [["mbt_enabled", "mbt_master_data"]]
    );
    config.mbt.enabled = false;
    config.mbtPhase3.masterDataEnabled = false;
    let transportCalls = 0;
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.operator = { id: ACTOR.operatorId, role: "admin", roles: ["admin"], homeRoute: "/admin" };
      next();
    });
    app.use("/api/mbt", createMbtRouter({
      netSuiteTransport: async () => {
        transportCalls += 1;
        throw new Error("Local master setup must never call NetSuite.");
      }
    }));
    const server = app.listen(0, "127.0.0.1");
    await new Promise((resolve) => server.once("listening", resolve));
    try {
      const address = server.address();
      assert.ok(address && typeof address === "object");
      const before = await query(
        `SELECT
           (SELECT count(*)::int FROM mbt_local_item_settings WHERE item_code = 'GATED_ITEM') AS items,
           (SELECT count(*)::int FROM mbt_materials WHERE material_code = 'GATED_MATERIAL') AS materials`
      );
      for (const request of [
        {
          path: "/api/mbt/config/local/items",
          body: {
            itemCode: "GATED_ITEM",
            displayName: "Must not exist",
            description: "",
            category: "other",
            pricingMode: "custom_price",
            active: true,
            reason: "closed gate"
          }
        },
        {
          path: "/api/mbt/config/materials",
          body: {
            materialCode: "GATED_MATERIAL",
            displayName: "Must not exist",
            description: "",
            active: true,
            reason: "closed gate"
          }
        }
      ]) {
        const response = await fetch(`http://127.0.0.1:${address.port}${request.path}`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "idempotency-key": `closed-${crypto.randomUUID()}`
          },
          body: JSON.stringify(request.body)
        });
        const body = await response.json().catch(() => ({}));
        assert.equal(response.status, 409);
        assert.match(response.headers.get("cache-control") || "", /no-store/i);
        assert.equal(body.code, "MBT_CAPABILITY_DISABLED");
        assert.equal(body.details?.capability, "master_data");
      }
      const afterState = await query(
        `SELECT
           (SELECT count(*)::int FROM mbt_local_item_settings WHERE item_code = 'GATED_ITEM') AS items,
           (SELECT count(*)::int FROM mbt_materials WHERE material_code = 'GATED_MATERIAL') AS materials`
      );
      assert.deepEqual(afterState.rows[0], before.rows[0]);
      assert.equal(transportCalls, 0);
    } finally {
      await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
      config.mbt.enabled = environmentBefore.root;
      config.mbtPhase3.masterDataEnabled = environmentBefore.capability;
    }
  });
});
