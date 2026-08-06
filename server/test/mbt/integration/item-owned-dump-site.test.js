import assert from "node:assert/strict";
import crypto from "node:crypto";
import test, { after } from "node:test";

import { config } from "../../../src/config.js";
import { beginRollbackContext, closeDb, query } from "../../../src/db.js";
import {
  applyLocalMasterDataRows,
  listLocalMasterData
} from "../../../src/mbt/local-master-data-service.js";
import {
  applyLocalRateCardDraft,
  getLocalRateCardGraph
} from "../../../src/mbt/rate-card-configuration-service.js";

const RUN_ID = crypto.randomUUID().replaceAll("-", "").toUpperCase();
const ACTOR = Object.freeze({ operatorId: `item-owned-${RUN_ID}`, roles: Object.freeze(["admin"]) });
let sequence = 0;

after(async () => closeDb());

async function inRollback(operation) {
  const rollback = await beginRollbackContext();
  try {
    return await rollback.run(operation);
  } finally {
    await rollback.rollback();
  }
}

async function enableMasterData() {
  config.mbt.enabled = true;
  config.mbtPhase3.masterDataEnabled = true;
  await query(
    `UPDATE mbt_feature_flags
        SET enabled = true, updated_by = $1, updated_at = now()
      WHERE flag_key = ANY($2::text[])`,
    [ACTOR.operatorId, ["mbt_enabled", "mbt_master_data"]]
  );
}

function command(resource, rows) {
  sequence += 1;
  return {
    actor: ACTOR,
    resource,
    sourceKind: "manual",
    rows,
    reason: `Verify item-owned dump configuration ${sequence}`,
    idempotencyKey: `item-owned-${RUN_ID}-${sequence}`,
    correlationId: `item-owned-correlation-${RUN_ID}-${sequence}`,
    requestId: `item-owned-request-${RUN_ID}-${sequence}`
  };
}

test("a dump item owns dump-site acceptance while legacy material rows stay synchronized", async () => {
  await inRollback(async () => {
    await enableMasterData();
    const itemCode = `SOIL_${RUN_ID.slice(0, 8)}`;
    const siteCode = `SITE_${RUN_ID.slice(8, 16)}`;

    await applyLocalMasterDataRows(command("local_items", [{
      itemCode,
      displayName: "Clean soil",
      description: "Charged per tonne",
      itemType: "dump",
      rentalPeriodDays: null,
      applicableServiceTypes: ["dump_return"],
      applicableLegacySourceTypes: [],
      binTypeCode: null,
      netSuiteMappingLocalKey: null,
      active: true
    }]));

    const mirrored = await query(
      `SELECT item.item_type, item.pricing_mode, material.display_name, material.active
         FROM mbt_local_item_settings item
         JOIN mbt_materials material ON material.material_code = item.item_code
        WHERE item.item_code = $1`,
      [itemCode]
    );
    assert.deepEqual(mirrored.rows, [{
      item_type: "dump",
      pricing_mode: "rate_card",
      display_name: "Clean soil",
      active: true
    }]);

    await applyLocalMasterDataRows(command("dump_sites", [{
      dumpSiteCode: siteCode,
      displayName: "North soil dump",
      addressLine1: "1 Test Road",
      addressLine2: "",
      city: "Toronto",
      region: "ON",
      postalCode: "M1M 1M1",
      countryCode: "CA",
      phone: "",
      latitude: null,
      longitude: null,
      itemCode,
      accepted: true,
      scaleTicketRequired: true,
      notes: "",
      active: true
    }]));

    const compatibility = await query(
      `SELECT item_acceptance.accepted AS item_accepted,
              legacy_acceptance.accepted AS legacy_accepted
         FROM mbt_dump_sites site
         JOIN mbt_dump_site_items item_acceptance
           ON item_acceptance.dump_site_id = site.dump_site_id
          AND item_acceptance.item_code = $2
         JOIN mbt_materials material ON material.material_code = $2
         JOIN mbt_dump_site_materials legacy_acceptance
           ON legacy_acceptance.dump_site_id = site.dump_site_id
          AND legacy_acceptance.material_id = material.material_id
        WHERE site.dump_site_code = $1`,
      [siteCode, itemCode]
    );
    assert.deepEqual(compatibility.rows, [{ item_accepted: true, legacy_accepted: true }]);

    const listed = await listLocalMasterData("dump_sites");
    const site = listed.entities.find((candidate) => candidate.dumpSiteCode === siteCode);
    assert.deepEqual(site.dumpItems, [{
      itemCode,
      displayName: "Clean soil",
      accepted: true,
      scaleTicketRequired: true,
      active: true,
      revision: 1
    }]);
  });
});

test("one dump site atomically owns multiple accepted items and its weekly opening schedule", async () => {
  await inRollback(async () => {
    await enableMasterData();
    const suffix = RUN_ID.slice(24, 32);
    const soilCode = `SOIL_${suffix}`;
    const concreteCode = `CONCRETE_${suffix}`;
    const siteCode = `MULTI_${suffix}`;
    const item = (itemCode, displayName) => ({
      itemCode, displayName, description: `${displayName} per tonne`, itemType: "dump",
      rentalPeriodDays: null, applicableServiceTypes: ["dump_return"],
      applicableLegacySourceTypes: [], binTypeCode: null,
      netSuiteMappingLocalKey: null, active: true
    });
    await applyLocalMasterDataRows(command("local_items", [
      item(soilCode, "Clean soil"), item(concreteCode, "Concrete")
    ]));
    const baseSite = {
      dumpSiteCode: siteCode, displayName: "Multi-material dump", addressLine1: "2 Test Road",
      addressLine2: "", city: "Toronto", region: "ON", postalCode: "M2M 2M2",
      countryCode: "CA", phone: "", latitude: null, longitude: null, notes: "",
      active: true
    };
    await applyLocalMasterDataRows(command("dump_sites", [{
      ...baseSite,
      itemAcceptances: [
        { itemCode: soilCode, accepted: true, scaleTicketRequired: true, notes: "", active: true },
        { itemCode: concreteCode, accepted: true, scaleTicketRequired: false, notes: "", active: true }
      ],
      openingHours: [
        { isoWeekday: 1, opensAt: "07:00", closesAt: "17:00" },
        { isoWeekday: 6, opensAt: "08:00", closesAt: "13:00" }
      ]
    }]));
    let site = (await listLocalMasterData("dump_sites")).entities
      .find((candidate) => candidate.dumpSiteCode === siteCode);
    assert.deepEqual(site.dumpItems.filter(({ active }) => active).map(({ itemCode }) => itemCode), [concreteCode, soilCode]);
    assert.deepEqual(site.openingHours.map(({ isoWeekday, opensAt, closesAt }) => ({ isoWeekday, opensAt, closesAt })), [
      { isoWeekday: 1, opensAt: "07:00", closesAt: "17:00" },
      { isoWeekday: 6, opensAt: "08:00", closesAt: "13:00" }
    ]);

    await applyLocalMasterDataRows(command("dump_sites", [{
      ...baseSite,
      expectedRevision: 1,
      itemAcceptances: [
        { itemCode: concreteCode, accepted: true, scaleTicketRequired: true, notes: "", active: true }
      ],
      openingHours: [{ isoWeekday: 2, opensAt: "09:00", closesAt: "16:00" }]
    }]));
    site = (await listLocalMasterData("dump_sites")).entities
      .find((candidate) => candidate.dumpSiteCode === siteCode);
    assert.equal(site.dumpItems.find(({ itemCode }) => itemCode === soilCode).active, false);
    assert.deepEqual(site.openingHours.map(({ isoWeekday, opensAt, closesAt }) => ({ isoWeekday, opensAt, closesAt })), [
      { isoWeekday: 2, opensAt: "09:00", closesAt: "16:00" }
    ]);
  });
});

test("distance, rental, and dump pricing rows retain their owning local item", async () => {
  await inRollback(async () => {
    await enableMasterData();
    const suffix = RUN_ID.slice(16, 24);
    const deliveryItemCode = `DELIVERY_${suffix}`;
    const dumpItemCode = `CONCRETE_${suffix}`;
    await applyLocalMasterDataRows(command("local_items", [{
      itemCode: deliveryItemCode,
      displayName: "MBT delivery fee",
      description: "Custom distance bands",
      itemType: "delivery_fee",
      rentalPeriodDays: null,
      applicableServiceTypes: ["delivery"],
      applicableLegacySourceTypes: [],
      binTypeCode: null,
      netSuiteMappingLocalKey: null,
      active: true
    }, {
      itemCode: dumpItemCode,
      displayName: "Concrete",
      description: "Customer concrete dump tariff",
      itemType: "dump",
      rentalPeriodDays: null,
      applicableServiceTypes: ["dump_return"],
      applicableLegacySourceTypes: [],
      binTypeCode: null,
      netSuiteMappingLocalKey: null,
      active: true
    }]));

    const created = await applyLocalRateCardDraft({
      actor: ACTOR,
      sourceKind: "manual",
      graph: {
        rateCard: {
          rateCardCode: `ITEM_OWNED_${suffix}`,
          displayName: "Item-owned pricing test",
          description: "Rollback-only integration evidence",
          customerNetSuiteId: null,
          subsidiaryNetSuiteId: null,
          serviceTemplateCode: null,
          currency: "CAD",
          active: true
        },
        version: {
          versionNumber: 1,
          effectiveFrom: "2036-08-04T12:00:00.000Z",
          effectiveTo: null,
          defaultRentalCalendarDays: 14,
          calculationNotes: "Each price row retains its item."
        },
        distanceBands: [{
          itemCode: deliveryItemCode,
          serviceCode: "delivery",
          binTypeCode: "14YD",
          sequenceNumber: 0,
          minimumMetres: 0,
          maximumMetres: null,
          amountMinor: 25000,
          downtownSurchargeMinor: 0,
          currency: "CAD",
          description: "Delivery fee"
        }],
        components: [{
          itemCode: "14YD",
          componentCode: "rental_14yd",
          componentKind: "rental",
          serviceCode: "delivery",
          binTypeCode: "14YD",
          rateBasis: "flat",
          amountMinor: 30000,
          percentageBasisPoints: null,
          defaultQuantity: 1,
          currency: "CAD",
          taxable: true,
          active: true,
          description: "14YD rental"
        }],
        dumpTariffs: [{
          itemCode: dumpItemCode,
          dumpSiteCode: null,
          materialCode: null,
          tariffCode: `customer_${suffix.toLowerCase()}`,
          pricingBasis: "per_weight",
          unitOfMeasure: "TONNE",
          amountMinor: 9000,
          minimumAmountMinor: 0,
          currency: "CAD",
          active: true,
          description: "Concrete per tonne"
        }],
        depositRules: []
      },
      reason: "Verify item-owned pricing persistence",
      idempotencyKey: `item-owned-rate-${RUN_ID}`,
      correlationId: `item-owned-rate-correlation-${RUN_ID}`,
      requestId: `item-owned-rate-request-${RUN_ID}`
    });

    const versionId = created.body.version.rateCardVersionId;
    const stored = await query(
      `SELECT
         (SELECT item_code FROM mbt_rate_distance_bands WHERE rate_card_version_id = $1) AS band_item,
         (SELECT item_code FROM mbt_rate_components WHERE rate_card_version_id = $1) AS component_item,
         (SELECT item_code FROM mbt_dump_tariffs WHERE rate_card_version_id = $1) AS tariff_item`,
      [versionId]
    );
    assert.deepEqual(stored.rows, [{
      band_item: deliveryItemCode,
      component_item: "14YD",
      tariff_item: dumpItemCode
    }]);

    const detail = await getLocalRateCardGraph(versionId);
    assert.equal(detail.graph.distanceBands[0].itemCode, deliveryItemCode);
    assert.equal(detail.graph.components[0].itemCode, "14YD");
    assert.equal(detail.graph.dumpTariffs[0].itemCode, dumpItemCode);
  });
});
