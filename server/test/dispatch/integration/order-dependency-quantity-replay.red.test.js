import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test, { after } from "node:test";

import { beginRollbackContext, closeDb, query } from "../../../src/db.js";
import {
  enrichDispatchOrdersWithDependencies,
  listOrderDependencies,
  syncOrderDependenciesForTransferOrder
} from "../../../src/order-dependency-repository.js";

after(closeDb);

const replay = JSON.parse(await readFile(
  new URL("../../fixtures/order-dependency-quantity-replay.json", import.meta.url),
  "utf8"
));

function replayNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function unique(values) {
  return [...new Set(values)];
}

function expectedLineContribution(line) {
  return line.role === "sales_allocation"
    ? Math.min(replayNumber(line.allocated), replayNumber(line.toOutbound))
    : replayNumber(line.allocated);
}

test("all current active and attention SO-to-TO dependency shapes replay without false quantity attention", async () => {
  assert.equal(replay.schemaVersion, "order-dependency-quantity-replay-v1");
  assert.equal(replay.dependencies.length, replay.dependencyCount);
  assert.equal(
    replay.dependencies.flatMap((dependency) => dependency.lines).length,
    replay.lineCount
  );

  const rollback = await beginRollbackContext();
  try {
    await rollback.run(async () => {
      const base = 8_970_000_000_000 + (Date.now() % 1_000_000) * 1_000;
      let sequence = 1;
      const nextId = () => base + sequence++;
      const itemIdByKey = new Map();
      const salesOrderByTarget = new Map();
      const salesLineByTargetItem = new Map();
      const transferIdByDependency = new Map();
      const dependencyIdByKey = new Map();

      for (const itemKey of unique(replay.dependencies.flatMap((dependency) =>
        dependency.lines.map((line) => line.itemKey)))) {
        const itemId = nextId();
        itemIdByKey.set(itemKey, itemId);
        await query(
          `INSERT INTO inventory_items (
             item_id, item_name, item_type, item_type_text, stock_unit,
             item_weight, to_pcs
           ) VALUES ($1, $2, 'InvtPart', 'Inventory Item', 'EA', 1, 1)`,
          [itemId, `Replay ${itemKey}`]
        );
      }

      for (const targetKey of unique(replay.dependencies.map((dependency) => dependency.targetKey))) {
        const targetDependencies = replay.dependencies.filter((dependency) => dependency.targetKey === targetKey);
        const salesOrderId = nextId();
        const salesOrderRef = `SO-REPLAY-${targetKey}-${base}`;
        const baseYard = targetDependencies[0].baseYard;
        const baseYardId = { "3445": 1, "2967": 28, "12441": 15, "150": 26 }[baseYard];
        salesOrderByTarget.set(targetKey, { id: salesOrderId, ref: salesOrderRef, baseYard });
        await query(
          `INSERT INTO sales_orders (
             netsuite_id, tranid, trandate, customer, status, status_text,
             outbound_location_id, outbound_location, sales_order_type,
             fulfillment_status, operator_status, local_yard_order_status,
             dispatch_address, netsuite_active
           ) VALUES (
             $1, $2, current_date, 'Quantity replay', 'B',
             'Sales Order : Pending Fulfillment', $3, $4, 'Delivery',
             'open', 'open', 'Open', '100 Replay Street, Toronto, ON', true
           )`,
          [salesOrderId, salesOrderRef, baseYardId, baseYard]
        );

        const salesItems = unique(targetDependencies.flatMap((dependency) => dependency.lines
          .filter((line) => line.role === "sales_allocation")
          .map((line) => line.itemKey)));
        for (const itemKey of salesItems) {
          const quantity = targetDependencies.flatMap((dependency) => dependency.lines)
            .filter((line) => line.role === "sales_allocation" && line.itemKey === itemKey)
            .reduce((sum, line) => sum + replayNumber(line.allocated), 10);
          const salesLine = await query(
            `INSERT INTO sales_order_lines (
               sales_order_id, line_id, item_id, item_name, sku,
               item_type, item_type_text, quantity, unit,
               pallet_qty, layer_qty, section_qty, piece_qty,
               to_plt, to_lyr, to_sec, to_pcs,
               netsuite_committed_qty, netsuite_backordered_qty,
               netsuite_active, location_id, location
             ) VALUES (
               $1, $2, $3, $4, $4,
               'InvtPart', 'Inventory Item', $5, 'EA',
               0, 0, 0, $5,
               0, 0, 0, 1,
               10, $6, true, $7, $8
             ) RETURNING id`,
            [
              salesOrderId,
              nextId(),
              itemIdByKey.get(itemKey),
              `Replay ${itemKey}`,
              quantity,
              quantity - 10,
              baseYardId,
              baseYard
            ]
          );
          salesLineByTargetItem.set(`${targetKey}:${itemKey}`, salesLine.rows[0].id);
        }
      }

      for (const fixture of replay.dependencies) {
        const transferOrderId = nextId();
        const transferOrderRef = `TO-REPLAY-${fixture.key}-${base}`;
        const sourceYardId = { "3445": 1, "2967": 28, "12441": 15, "150": 26 }[fixture.sourceYard];
        const destinationYardId = { "3445": 1, "2967": 28, "12441": 15, "150": 26 }[fixture.baseYard];
        transferIdByDependency.set(fixture.key, transferOrderId);
        await query(
          `INSERT INTO transfer_orders (
             netsuite_id, tranid, trandate, status, status_text,
             from_location_id, from_location, to_location_id, to_location,
             outbound_operator_status, local_yard_order_status,
             fulfillment_status, receiving_status, dispatch_planned, netsuite_active
           ) VALUES (
             $1, $2, current_date, 'B', 'Transfer Order : Pending Fulfillment',
             $3, $4, $5, $6,
             'open', 'Open', 'not_fulfilled', 'pending', false, true
           )`,
          [transferOrderId, transferOrderRef, sourceYardId, fixture.sourceYard, destinationYardId, fixture.baseYard]
        );

        const transferLines = [];
        for (const line of fixture.lines) {
          const outboundId = nextId();
          const receivingId = nextId();
          const itemId = itemIdByKey.get(line.itemKey);
          for (const [id, stage, locationId, location] of [
            [outboundId, "outbound", sourceYardId, fixture.sourceYard],
            [receivingId, "receiving", destinationYardId, fixture.baseYard]
          ]) {
            await query(
              `INSERT INTO transfer_order_lines (
                 id, transfer_order_id, line_id, line_stage, item_id, item_name, sku,
                 item_type, item_type_text, quantity, unit,
                 pallet_qty, layer_qty, section_qty, piece_qty,
                 to_plt, to_lyr, to_sec, to_pcs,
                 netsuite_received_qty, netsuite_active, location_id, location
               ) VALUES (
                 $1, $2, $3, $4, $5, $6, $6,
                 'InvtPart', 'Inventory Item', $7, 'EA',
                 0, 0, 0, $7,
                 0, 0, 0, 1,
                 0, true, $8, $9
               )`,
              [id, transferOrderId, nextId(), stage, itemId, `Replay ${line.itemKey}`,
                line.toOutbound, locationId, location]
            );
          }
          transferLines.push({ fixture: line, outboundId, receivingId, itemId });
        }

        const salesOrder = salesOrderByTarget.get(fixture.targetKey);
        const dependency = (await query(
          `INSERT INTO order_dependencies (
             sales_order_id, sales_order_ref, dispatch_target_ref, dispatch_target_kind,
             transfer_order_id, transfer_order_ref, dependency_mode, same_load_required,
             status, attention_reason, source_location_id, source_location,
             accounting_destination_location_id, accounting_destination_location,
             reconciliation_status
           ) VALUES (
             $1, $2, $2, 'normal', $3, $4, $5, ($5 = 'direct_to_customer'),
             $6, $7, $8, $9, $10, $11, $12
           ) RETURNING id`,
          [
            salesOrder.id,
            salesOrder.ref,
            transferOrderId,
            transferOrderRef,
            fixture.mode,
            fixture.status,
            fixture.attentionReasonClass === "reduced_quantity_only"
              ? `${transferOrderRef} quantity is below its linked Sales Order allocation.`
              : null,
            sourceYardId,
            fixture.sourceYard,
            destinationYardId,
            fixture.baseYard,
            fixture.status === "attention" ? "attention" : "pending"
          ]
        )).rows[0];
        dependencyIdByKey.set(fixture.key, dependency.id);

        for (const line of transferLines) {
          const salesLineId = line.fixture.role === "sales_allocation"
            ? salesLineByTargetItem.get(`${fixture.targetKey}:${line.fixture.itemKey}`)
            : null;
          await query(
            `INSERT INTO order_dependency_lines (
               dependency_id, sales_line_id, transfer_outbound_line_id,
               transfer_receiving_line_id, item_id, item_name, unit,
               allocated_quantity, pallet_qty, layer_qty, section_qty, piece_qty,
               line_role, dispatch_target_line_key
             ) VALUES (
               $1, $2, $3, $4, $5, $6, 'EA',
               $7, 0, 0, 0, $7, $8, $9
             )`,
            [
              dependency.id,
              salesLineId,
              line.outboundId,
              line.receivingId,
              line.itemId,
              `Replay ${line.fixture.itemKey}`,
              line.fixture.allocated,
              line.fixture.role,
              salesLineId ? `${salesOrder.ref}::${salesOrder.ref}::${salesLineId}` : null
            ]
          );
        }

        if (fixture.transitDestination) {
          const transitId = { "3445": 1, "2967": 28, "12441": 15, "150": 26 }[fixture.transitDestination];
          await query(
            `INSERT INTO local_co_orders (
               co_ref, source_order_ref, from_location_id, from_location,
               to_location_id, to_location, status, details
             ) VALUES ($1, $2, $3, $4, $5, $6, 'pending_load', '{"replay":true}'::jsonb)`,
            [`CO-${transferOrderRef}`, transferOrderRef, sourceYardId, fixture.sourceYard,
              transitId, fixture.transitDestination]
          );
        }
      }

      const syncFailures = [];
      for (const fixture of replay.dependencies) {
        const sync = await syncOrderDependenciesForTransferOrder(transferIdByDependency.get(fixture.key));
        if (sync[0]?.attention !== false) {syncFailures.push({ key: fixture.key, sync: sync[0] });}
      }
      assert.deepEqual(syncFailures, []);

      for (const targetKey of unique(replay.dependencies.map((dependency) => dependency.targetKey))) {
        const target = salesOrderByTarget.get(targetKey);
        const targetFixtures = replay.dependencies.filter((dependency) => dependency.targetKey === targetKey);
        const dependencies = await listOrderDependencies({ salesOrderRef: target.ref });
        assert.equal(dependencies.length, targetFixtures.length);

        for (const fixture of targetFixtures) {
          const dependency = dependencies.find((entry) =>
            String(entry.id) === String(dependencyIdByKey.get(fixture.key)));
          assert.equal(dependency?.status, "active", fixture.key);
          for (const lineFixture of fixture.lines) {
            const line = dependency.lines.find((entry) =>
              String(entry.itemId) === String(itemIdByKey.get(lineFixture.itemKey)));
            assert.equal(line?.allocatedQuantity, lineFixture.allocated, `${fixture.key}:${lineFixture.itemKey}:saved`);
            assert.equal(
              line?.effectiveAllocatedQuantity,
              expectedLineContribution(lineFixture),
              `${fixture.key}:${lineFixture.itemKey}:effective`
            );
          }
        }

        const salesItems = unique(targetFixtures.flatMap((dependency) => dependency.lines
          .filter((line) => line.role === "sales_allocation")
          .map((line) => line.itemKey))).map((itemKey) => {
          const quantity = targetFixtures.flatMap((dependency) => dependency.lines)
            .filter((line) => line.role === "sales_allocation" && line.itemKey === itemKey)
            .reduce((sum, line) => sum + replayNumber(line.allocated), 10);
          return {
            itemId: itemIdByKey.get(itemKey),
            itemName: `Replay ${itemKey}`,
            quantity,
            salesQty: quantity,
            pieces: quantity
          };
        });
        const input = [{
          id: target.ref,
          type: "SO",
          sourceYard: target.baseYard,
          pickupLocations: [target.baseYard],
          items: salesItems
        }];
        const [first] = await enrichDispatchOrdersWithDependencies(input);
        const [second] = await enrichDispatchOrdersWithDependencies(input);
        assert.deepEqual(second, first, `${targetKey}: deterministic replay`);

        const directFixtures = targetFixtures.filter((dependency) => dependency.mode === "direct_to_customer");
        const expectedLocations = unique([
          target.baseYard,
          ...directFixtures.map((dependency) => dependency.transitDestination || dependency.sourceYard)
        ]);
        assert.deepEqual(first.pickupLocations, expectedLocations, `${targetKey}: route locations`);
        for (const dependency of targetFixtures.filter((entry) => entry.mode === "yard_replenishment")) {
          if (!expectedLocations.includes(dependency.sourceYard)) {
            assert.equal(first.pickupLocations.includes(dependency.sourceYard), false, `${dependency.key}: replenishment route leak`);
          }
        }

        for (const item of salesItems) {
          const directQuantity = first.directPickupManifest.flatMap((entry) => entry.items)
            .filter((entry) => String(entry.itemId) === String(item.itemId))
            .reduce((sum, entry) => sum + replayNumber(entry.quantity), 0);
          const baseResidual = replayNumber(item.quantity) - directQuantity;
          assert.ok(baseResidual >= 0, `${targetKey}:${item.itemName}: non-negative base residual`);
          assert.equal(baseResidual + directQuantity, replayNumber(item.quantity), `${targetKey}:${item.itemName}: conservation`);
        }
      }
    });
  } finally {
    await rollback.rollback();
  }
});
