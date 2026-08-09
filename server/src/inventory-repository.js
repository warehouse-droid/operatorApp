import { query, withTransaction } from "./db.js";
import { writeAudit } from "./auth-repository.js";
import { enqueueNetSuiteMirrorInventoryEvent } from "./netsuite-mirror-repository.js";
import { defaultReturnPolicy, normalizeReturnPolicy } from "./return-policy.js";

function normalizeNumber(value) {
  if (value === null || value === undefined || value === "") return 0;
  return Number(String(value).replaceAll(",", ""));
}

function nullableNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  return Number(String(value).replaceAll(",", ""));
}

function nullableBoolean(value) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "boolean") return value;
  return ["t", "true", "1", "yes", "y"].includes(String(value).trim().toLowerCase());
}

function ruleBasedClassification(itemName = "") {
  const name = String(itemName || "").trim();
  const [prefix = "", series = ""] = name.split("-");
  const key = prefix.toUpperCase();
  const rules = {
    UNI: { productType: "Interlocking", brand: "Unilock" },
    BWS: { productType: "Interlocking", brand: "BWS" },
    PER: { productType: "Interlocking", brand: "Per" },
    BC: { productType: "Interlocking", brand: "Browns" },
    ARCH: { productType: "Natural Stone", brand: "Stone Arch" },
    BNS: { productType: "Natural Stone", brand: "Banas" },
    OAK: { productType: "Natural Stone", brand: "Oakville" }
  };
  const rule = rules[key];
  if (!rule) return { productType: null, brand: null, series: null };
  return {
    productType: rule.productType,
    brand: rule.brand,
    series: series || null
  };
}

export async function upsertInventoryBalances(rows) {
  let itemCount = 0;
  let balanceCount = 0;

  for (const row of rows) {
    const itemId = Number(row.item_id);
    const locationId = Number(row.location_id);
    if (!Number.isInteger(itemId) || !Number.isInteger(locationId)) continue;
    const classification = ruleBasedClassification(row.item_name || row.display_name || "");

    await query(
      `INSERT INTO inventory_items (
         item_id, item_name, display_name, item_description, item_type, item_type_text,
         stock_unit, purchase_unit, item_weight, to_plt, to_lyr, to_sec, to_pcs, product_type, brand, series,
         vendor_id, vendor, netsuite_lead_time_days, netsuite_safety_stock_level,
         netsuite_seasonal_demand, last_purchase_price, raw, synced_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15,
                 $16, $17, $18, $19, $20, $21, $22, $23::jsonb, now())
       ON CONFLICT (item_id) DO UPDATE SET
         item_name = EXCLUDED.item_name,
         display_name = EXCLUDED.display_name,
         item_description = EXCLUDED.item_description,
         item_type = EXCLUDED.item_type,
         item_type_text = EXCLUDED.item_type_text,
         stock_unit = EXCLUDED.stock_unit,
         purchase_unit = EXCLUDED.purchase_unit,
         item_weight = EXCLUDED.item_weight,
         to_plt = EXCLUDED.to_plt,
         to_lyr = EXCLUDED.to_lyr,
         to_sec = EXCLUDED.to_sec,
         to_pcs = EXCLUDED.to_pcs,
         vendor_id = EXCLUDED.vendor_id,
         vendor = EXCLUDED.vendor,
         netsuite_lead_time_days = EXCLUDED.netsuite_lead_time_days,
         netsuite_safety_stock_level = EXCLUDED.netsuite_safety_stock_level,
         netsuite_seasonal_demand = EXCLUDED.netsuite_seasonal_demand,
         last_purchase_price = EXCLUDED.last_purchase_price,
         product_type = CASE WHEN inventory_items.classification_updated_by IS NULL THEN EXCLUDED.product_type ELSE inventory_items.product_type END,
         brand = CASE WHEN inventory_items.classification_updated_by IS NULL THEN EXCLUDED.brand ELSE inventory_items.brand END,
         series = CASE WHEN inventory_items.classification_updated_by IS NULL THEN EXCLUDED.series ELSE inventory_items.series END,
         raw = EXCLUDED.raw,
         synced_at = now()`,
      [
        itemId,
        row.item_name || String(itemId),
        row.display_name || null,
        row.item_description || null,
        row.item_type || null,
        row.item_type_text || null,
        row.stock_unit || null,
        row.purchase_unit || null,
        nullableNumber(row.item_weight),
        nullableNumber(row.to_plt),
        nullableNumber(row.to_lyr),
        nullableNumber(row.to_sec),
        nullableNumber(row.to_pcs),
        classification.productType,
        classification.brand,
        classification.series,
        nullableNumber(row.vendor_id),
        row.vendor || null,
        nullableNumber(row.netsuite_lead_time_days),
        nullableNumber(row.netsuite_safety_stock_level),
        nullableBoolean(row.netsuite_seasonal_demand),
        nullableNumber(row.last_purchase_price),
        JSON.stringify(row)
      ]
    );
    itemCount += 1;

    await query(
      `INSERT INTO inventory_balances (
         item_id, location_id, location, quantity_on_hand, quantity_available,
         quantity_on_order, quantity_backordered, synced_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, now())
       ON CONFLICT (item_id, location_id) DO UPDATE SET
         location = EXCLUDED.location,
         quantity_on_hand = EXCLUDED.quantity_on_hand,
         quantity_available = EXCLUDED.quantity_available,
         quantity_on_order = EXCLUDED.quantity_on_order,
         quantity_backordered = EXCLUDED.quantity_backordered,
         synced_at = now()`,
      [
        itemId,
        locationId,
        row.location || null,
        normalizeNumber(row.quantity_on_hand),
        normalizeNumber(row.quantity_available),
        normalizeNumber(row.quantity_on_order),
        normalizeNumber(row.quantity_backordered)
      ]
    );
    balanceCount += 1;
  }
  await enqueueNetSuiteMirrorInventoryEvent(rows.map((row) => row.item_id));

  return { items: itemCount, balances: balanceCount };
}

export async function upsertInventoryBalancesBulk(rows = []) {
  const validRows = (rows || []).filter((row) => Number.isInteger(Number(row.item_id)) && Number.isInteger(Number(row.location_id)));
  const itemRows = [...new Map(validRows.map((row) => [Number(row.item_id), row])).values()];

  for (let offset = 0; offset < itemRows.length; offset += 150) {
    const group = itemRows.slice(offset, offset + 150);
    const params = [];
    const values = group.map((row) => {
      const classification = ruleBasedClassification(row.item_name || row.display_name || "");
      const fields = [
        Number(row.item_id), row.item_name || String(row.item_id), row.display_name || null,
        row.item_description || null, row.item_type || null, row.item_type_text || null,
        row.stock_unit || null, row.purchase_unit || null, nullableNumber(row.item_weight), nullableNumber(row.to_plt),
        nullableNumber(row.to_lyr), nullableNumber(row.to_sec), nullableNumber(row.to_pcs),
        classification.productType, classification.brand, classification.series,
        nullableNumber(row.vendor_id), row.vendor || null, nullableNumber(row.netsuite_lead_time_days),
        nullableNumber(row.netsuite_safety_stock_level), nullableBoolean(row.netsuite_seasonal_demand),
        nullableNumber(row.last_purchase_price), JSON.stringify(row)
      ];
      const placeholders = fields.map((field) => {
        params.push(field);
        return `$${params.length}`;
      });
      placeholders[22] += "::jsonb";
      return `(${placeholders.join(", ")}, now())`;
    });
    await query(
      `INSERT INTO inventory_items (
         item_id, item_name, display_name, item_description, item_type, item_type_text,
         stock_unit, purchase_unit, item_weight, to_plt, to_lyr, to_sec, to_pcs, product_type, brand, series,
         vendor_id, vendor, netsuite_lead_time_days, netsuite_safety_stock_level,
         netsuite_seasonal_demand, last_purchase_price, raw, synced_at
       ) VALUES ${values.join(", ")}
       ON CONFLICT (item_id) DO UPDATE SET
         item_name = EXCLUDED.item_name,
         display_name = EXCLUDED.display_name,
         item_description = EXCLUDED.item_description,
         item_type = EXCLUDED.item_type,
         item_type_text = EXCLUDED.item_type_text,
         stock_unit = EXCLUDED.stock_unit,
         purchase_unit = EXCLUDED.purchase_unit,
         item_weight = EXCLUDED.item_weight,
         to_plt = EXCLUDED.to_plt,
         to_lyr = EXCLUDED.to_lyr,
         to_sec = EXCLUDED.to_sec,
         to_pcs = EXCLUDED.to_pcs,
         vendor_id = EXCLUDED.vendor_id,
         vendor = EXCLUDED.vendor,
         netsuite_lead_time_days = EXCLUDED.netsuite_lead_time_days,
         netsuite_safety_stock_level = EXCLUDED.netsuite_safety_stock_level,
         netsuite_seasonal_demand = EXCLUDED.netsuite_seasonal_demand,
         product_type = CASE WHEN inventory_items.classification_updated_by IS NULL THEN EXCLUDED.product_type ELSE inventory_items.product_type END,
         last_purchase_price = EXCLUDED.last_purchase_price,
         brand = CASE WHEN inventory_items.classification_updated_by IS NULL THEN EXCLUDED.brand ELSE inventory_items.brand END,
         series = CASE WHEN inventory_items.classification_updated_by IS NULL THEN EXCLUDED.series ELSE inventory_items.series END,
         raw = EXCLUDED.raw,
         synced_at = now()`,
      params
    );
  }

  for (let offset = 0; offset < validRows.length; offset += 300) {
    const group = validRows.slice(offset, offset + 300);
    const params = [];
    const values = group.map((row) => {
      const fields = [
        Number(row.item_id), Number(row.location_id), row.location || null,
        normalizeNumber(row.quantity_on_hand), normalizeNumber(row.quantity_available),
        normalizeNumber(row.quantity_on_order), normalizeNumber(row.quantity_backordered)
      ];
      return `(${fields.map((field) => {
        params.push(field);
        return `$${params.length}`;
      }).join(", ")}, now())`;
    });
    await query(
      `INSERT INTO inventory_balances (
         item_id, location_id, location, quantity_on_hand, quantity_available,
         quantity_on_order, quantity_backordered, synced_at
       ) VALUES ${values.join(", ")}
       ON CONFLICT (item_id, location_id) DO UPDATE SET
         location = EXCLUDED.location,
         quantity_on_hand = EXCLUDED.quantity_on_hand,
         quantity_available = EXCLUDED.quantity_available,
         quantity_on_order = EXCLUDED.quantity_on_order,
         quantity_backordered = EXCLUDED.quantity_backordered,
         synced_at = now()`,
      params
    );
  }

  await enqueueNetSuiteMirrorInventoryEvent(itemRows.map((row) => row.item_id));
  return { items: itemRows.length, balances: validRows.length };
}

export async function applyInventoryClassificationRules() {
  const result = await query(
    `SELECT item_id, item_name, display_name
     FROM inventory_items
     WHERE classification_updated_by IS NULL`
  );
  let updated = 0;
  for (const item of result.rows) {
    const classification = ruleBasedClassification(item.item_name || item.display_name || "");
    if (!classification.productType && !classification.brand && !classification.series) continue;
    await query(
      `UPDATE inventory_items
       SET product_type = $2,
           brand = $3,
           series = $4
       WHERE item_id = $1
         AND classification_updated_by IS NULL`,
      [item.item_id, classification.productType, classification.brand, classification.series]
    );
    updated += 1;
  }
  return { scanned: result.rowCount, updated };
}

export async function listInventoryClassifications({ search = null, limit = 300 } = {}) {
  const params = [];
  const clauses = ["1 = 1"];
  if (search) {
    params.push(`%${String(search).trim()}%`);
    clauses.push(`(i.item_name ILIKE $${params.length} OR i.display_name ILIKE $${params.length} OR i.item_description ILIKE $${params.length})`);
  }
  params.push(Math.min(Math.max(Number(limit) || 300, 1), 1000));
  const result = await query(
    `SELECT i.item_id,
            i.item_name,
            i.display_name,
            i.item_description,
            i.item_type_text,
            i.stock_unit,
            i.product_type,
            i.return_policy_override,
            CASE
              WHEN i.return_policy_override IS NOT NULL THEN i.return_policy_override
              WHEN LOWER(REGEXP_REPLACE(REPLACE(BTRIM(COALESCE(i.product_type, '')), '_', ' '), '[[:space:]]+', ' ', 'g')) = 'interlocking' THEN 'ALLOWED'
              WHEN LOWER(REGEXP_REPLACE(REPLACE(BTRIM(COALESCE(i.product_type, '')), '_', ' '), '[[:space:]]+', ' ', 'g')) = 'natural stone' THEN 'APPROVAL_REQUIRED'
              ELSE 'NOT_RETURNABLE'
            END AS return_policy_effective,
            i.brand,
            i.series,
            i.to_plt,
            i.to_lyr,
            i.to_sec,
            i.to_pcs,
            i.classification_updated_at,
            o.display_name AS classification_updated_by_name,
            COALESCE(SUM(b.quantity_on_hand), 0) AS total_on_hand,
            COALESCE(SUM(b.quantity_available), 0) AS total_available
     FROM inventory_items i
     LEFT JOIN inventory_balances b ON b.item_id = i.item_id
     LEFT JOIN operators o ON o.id = i.classification_updated_by
     WHERE ${clauses.join(" AND ")}
     GROUP BY i.item_id, o.display_name
     ORDER BY i.item_name
     LIMIT $${params.length}`,
    params
  );
  return result.rows;
}

export async function updateInventoryClassification(operatorId, itemId, values, {
  allowReturnPolicyChange = false
} = {}) {
  return withTransaction(async () => {
    const currentResult = await query(
      `SELECT item_id, product_type, brand, series, return_policy_override
         FROM inventory_items
        WHERE item_id = $1
        FOR UPDATE`,
      [Number(itemId)]
    );
    if (!currentResult.rowCount) throw new Error("Inventory item not found.");
    const current = currentResult.rows[0];
    const hasProductType = Object.hasOwn(values || {}, "productType");
    const hasBrand = Object.hasOwn(values || {}, "brand");
    const hasSeries = Object.hasOwn(values || {}, "series");
    const hasReturnPolicy = Object.hasOwn(values || {}, "returnPolicyOverride");
    const expectedReturnPolicyContext = values?.expectedReturnPolicyContext;
    if (expectedReturnPolicyContext !== undefined
        && (!expectedReturnPolicyContext
          || typeof expectedReturnPolicyContext !== "object"
          || Array.isArray(expectedReturnPolicyContext))) {
      throw Object.assign(new Error("Return Policy revision is invalid. Reload Item Classification and try again."), {
        status: 400
      });
    }
    if ((hasProductType || hasReturnPolicy) && expectedReturnPolicyContext) {
      const expectedProductType = String(expectedReturnPolicyContext.productType || "").trim();
      const expectedOverride = normalizeReturnPolicy(
        expectedReturnPolicyContext.returnPolicyOverride,
        { nullable: true }
      );
      if (expectedProductType !== String(current.product_type || "").trim()
          || expectedOverride !== current.return_policy_override) {
        throw Object.assign(new Error("Return Policy changed after this screen loaded. Reload Item Classification before saving."), {
          status: 409,
          code: "RETURN_POLICY_REVISION_CONFLICT"
        });
      }
    }
    const nextProductType = hasProductType
      ? String(values.productType || "").trim()
      : String(current.product_type || "").trim();
    const nextBrand = hasBrand ? String(values.brand || "").trim() : String(current.brand || "").trim();
    const nextSeries = hasSeries ? String(values.series || "").trim() : String(current.series || "").trim();
    const returnPolicyOverride = hasReturnPolicy
      ? normalizeReturnPolicy(values.returnPolicyOverride, { nullable: true })
      : current.return_policy_override;
    const classificationChanged = nextProductType !== String(current.product_type || "").trim()
      || nextBrand !== String(current.brand || "").trim()
      || nextSeries !== String(current.series || "").trim();
    const returnPolicyChanged = hasReturnPolicy
      && returnPolicyOverride !== current.return_policy_override;
    const productTypeChangesReturnDefault = defaultReturnPolicy(current.product_type)
      !== defaultReturnPolicy(nextProductType);
    if (!allowReturnPolicyChange && (productTypeChangesReturnDefault || returnPolicyChanged)) {
      throw Object.assign(new Error("Only an admin can change a product type or override that changes company-wide return eligibility."), {
        status: 403
      });
    }
    const result = await query(
      `UPDATE inventory_items
          SET product_type = CASE WHEN $6::boolean THEN nullif($2, '') ELSE product_type END,
              brand = CASE WHEN $7::boolean THEN nullif($3, '') ELSE brand END,
              series = CASE WHEN $8::boolean THEN nullif($4, '') ELSE series END,
              classification_updated_at = CASE WHEN $9::boolean THEN now() ELSE classification_updated_at END,
              classification_updated_by = CASE WHEN $9::boolean THEN $5 ELSE classification_updated_by END,
              return_policy_override = CASE WHEN $10::boolean THEN $11::text ELSE return_policy_override END,
              return_policy_updated_by = CASE
                WHEN $10::boolean AND return_policy_override IS DISTINCT FROM $11::text THEN $5
                ELSE return_policy_updated_by
              END,
              return_policy_updated_at = CASE
                WHEN $10::boolean AND return_policy_override IS DISTINCT FROM $11::text THEN now()
                ELSE return_policy_updated_at
              END
        WHERE item_id = $1
        RETURNING item_id, item_name, display_name, item_description, item_type_text,
                  stock_unit, product_type, brand, series, return_policy_override,
                  CASE
                    WHEN return_policy_override IS NOT NULL THEN return_policy_override
                    WHEN LOWER(REGEXP_REPLACE(REPLACE(BTRIM(COALESCE(product_type, '')), '_', ' '), '[[:space:]]+', ' ', 'g')) = 'interlocking' THEN 'ALLOWED'
                    WHEN LOWER(REGEXP_REPLACE(REPLACE(BTRIM(COALESCE(product_type, '')), '_', ' '), '[[:space:]]+', ' ', 'g')) = 'natural stone' THEN 'APPROVAL_REQUIRED'
                    ELSE 'NOT_RETURNABLE'
                  END AS return_policy_effective,
                  classification_updated_at`,
      [
        Number(itemId),
        nextProductType,
        nextBrand,
        nextSeries,
        operatorId,
        hasProductType,
        hasBrand,
        hasSeries,
        classificationChanged,
        hasReturnPolicy,
        returnPolicyOverride
      ]
    );
    if (classificationChanged || returnPolicyChanged) {
      await writeAudit({
        actorOperatorId: operatorId,
        source: "inventory",
        action: "inventory.classification.update",
        details: {
          itemId: Number(itemId),
          before: current,
          after: {
            productType: nextProductType,
            brand: nextBrand,
            series: nextSeries,
            returnPolicyOverride
          },
          classificationChanged,
          returnPolicyChanged
        }
      });
    }
    return result.rows[0];
  });
}

export async function listInventoryFacets({ locationId = null, productType = null, brand = null } = {}) {
  const params = [];
  const clauses = ["1 = 1"];
  if (locationId) {
    params.push(Number(locationId));
    clauses.push(`b.location_id = $${params.length}`);
  }
  if (productType) {
    if (productType === "Unclassified") {
      clauses.push(`i.product_type IS NULL`);
    } else {
      params.push(productType);
      clauses.push(`i.product_type = $${params.length}`);
    }
  }
  if (brand) {
    if (brand === "Unclassified") {
      clauses.push(`i.brand IS NULL`);
    } else {
      params.push(brand);
      clauses.push(`i.brand = $${params.length}`);
    }
  }

  const where = clauses.join(" AND ");
  const [productTypes, brands, series] = await Promise.all([
    query(
      `SELECT COALESCE(i.product_type, 'Unclassified') AS value, COUNT(*)::int AS count
       FROM inventory_items i
       INNER JOIN inventory_balances b ON b.item_id = i.item_id
       WHERE ${where}
       GROUP BY COALESCE(i.product_type, 'Unclassified')
       ORDER BY COALESCE(i.product_type, 'Unclassified')`,
      params
    ),
    query(
      `SELECT COALESCE(i.brand, 'Unclassified') AS value, COUNT(*)::int AS count
       FROM inventory_items i
       INNER JOIN inventory_balances b ON b.item_id = i.item_id
       WHERE ${where}
       GROUP BY COALESCE(i.brand, 'Unclassified')
       ORDER BY COALESCE(i.brand, 'Unclassified')`,
      params
    ),
    query(
      `SELECT COALESCE(i.series, 'Unclassified') AS value, COUNT(*)::int AS count
       FROM inventory_items i
       INNER JOIN inventory_balances b ON b.item_id = i.item_id
       WHERE ${where}
       GROUP BY COALESCE(i.series, 'Unclassified')
       ORDER BY COALESCE(i.series, 'Unclassified')`,
      params
    )
  ]);

  return {
    productTypes: productTypes.rows,
    brands: brands.rows,
    series: series.rows
  };
}

export async function listInventoryItems({ locationId = null, productType = null, brand = null, series = null, search = null, limit = 80 } = {}) {
  const params = [];
  const clauses = ["1 = 1"];
  if (locationId) {
    params.push(Number(locationId));
    clauses.push(`b.location_id = $${params.length}`);
  }
  if (productType) {
    if (productType === "Unclassified") {
      clauses.push(`i.product_type IS NULL`);
    } else {
      params.push(productType);
      clauses.push(`i.product_type = $${params.length}`);
    }
  }
  if (brand) {
    if (brand === "Unclassified") {
      clauses.push(`i.brand IS NULL`);
    } else {
      params.push(brand);
      clauses.push(`i.brand = $${params.length}`);
    }
  }
  if (series) {
    if (series === "Unclassified") {
      clauses.push(`i.series IS NULL`);
    } else {
      params.push(series);
      clauses.push(`i.series = $${params.length}`);
    }
  }
  if (search) {
    params.push(`%${String(search).trim()}%`);
    clauses.push(`(i.item_name ILIKE $${params.length} OR i.display_name ILIKE $${params.length} OR i.item_description ILIKE $${params.length})`);
  }
  params.push(Math.min(Math.max(Number(limit) || 80, 1), 200));

  const result = await query(
    `SELECT i.*,
            b.location_id,
            b.location,
            b.quantity_on_hand,
            b.quantity_available
     FROM inventory_items i
     INNER JOIN inventory_balances b ON b.item_id = i.item_id
     WHERE ${clauses.join(" AND ")}
     ORDER BY i.product_type, i.brand, i.series, i.item_name
     LIMIT $${params.length}`,
    params
  );
  return result.rows;
}

export async function getDraftCycleCount(operatorId) {
  const existing = await query(
    `SELECT id
     FROM cycle_count_records
     WHERE operator_id = $1
       AND status = 'draft'
     ORDER BY updated_at DESC
     LIMIT 1`,
    [operatorId]
  );
  if (existing.rowCount) return existing.rows[0].id;

  const created = await query(
    `INSERT INTO cycle_count_records (operator_id)
     VALUES ($1)
     RETURNING id`,
    [operatorId]
  );
  return created.rows[0].id;
}

export async function confirmCycleCountLine(operatorId, values) {
  const recordId = await getDraftCycleCount(operatorId);
  const itemId = Number(values.itemId);
  const locationId = Number(values.locationId);
  if (!Number.isInteger(itemId) || !Number.isInteger(locationId)) throw new Error("Valid item and location are required.");

  const balance = await query(
    `SELECT b.quantity_on_hand,
            b.quantity_available,
            i.to_plt,
            i.to_lyr,
            i.to_sec,
            i.to_pcs
     FROM inventory_balances b
     INNER JOIN inventory_items i ON i.item_id = b.item_id
     WHERE b.item_id = $1
       AND b.location_id = $2`,
    [itemId, locationId]
  );
  if (!balance.rowCount) throw new Error("Inventory item not found for this location.");

  const pallets = normalizeNumber(values.pallets);
  const layers = normalizeNumber(values.layers);
  const sections = normalizeNumber(values.sections);
  const pieces = normalizeNumber(values.pieces);
  const conversion = balance.rows[0];
  const toPlt = normalizeNumber(conversion.to_plt);
  const toLyr = normalizeNumber(conversion.to_lyr);
  const toSec = normalizeNumber(conversion.to_sec);
  const toPcs = normalizeNumber(conversion.to_pcs) || 1;
  const countedTotal = (pallets * toPlt) + (layers * toLyr) + (sections * toSec) + (pieces * toPcs);
  const variance = countedTotal - normalizeNumber(conversion.quantity_on_hand);
  await query(
    `INSERT INTO cycle_count_lines (
       record_id, item_id, location_id, counted_pallet_qty, counted_layer_qty,
       counted_section_qty, counted_piece_qty, counted_total_qty, variance_qty,
       system_on_hand_qty, system_available_qty, to_plt, to_lyr, to_sec, to_pcs, confirmed_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, now())
     ON CONFLICT (record_id, item_id, location_id) DO UPDATE SET
       counted_pallet_qty = EXCLUDED.counted_pallet_qty,
       counted_layer_qty = EXCLUDED.counted_layer_qty,
       counted_section_qty = EXCLUDED.counted_section_qty,
       counted_piece_qty = EXCLUDED.counted_piece_qty,
       counted_total_qty = EXCLUDED.counted_total_qty,
       variance_qty = EXCLUDED.variance_qty,
       system_on_hand_qty = EXCLUDED.system_on_hand_qty,
       system_available_qty = EXCLUDED.system_available_qty,
       to_plt = EXCLUDED.to_plt,
       to_lyr = EXCLUDED.to_lyr,
       to_sec = EXCLUDED.to_sec,
       to_pcs = EXCLUDED.to_pcs,
       confirmed_at = now()`,
    [
      recordId,
      itemId,
      locationId,
      pallets,
      layers,
      sections,
      pieces,
      countedTotal,
      variance,
      conversion.quantity_on_hand,
      conversion.quantity_available,
      toPlt,
      toLyr,
      toSec,
      toPcs
    ]
  );
  await query("UPDATE cycle_count_records SET updated_at = now() WHERE id = $1", [recordId]);
  await writeAudit({
    actorOperatorId: operatorId,
    source: "cycle_count",
    action: "cycle_count.line.confirm",
    details: { recordId, itemId, locationId, pallets, layers, sections, pieces, countedTotal, variance }
  });
  return getCycleCountDraft(operatorId);
}

export async function getCycleCountDraft(operatorId) {
  const recordId = await getDraftCycleCount(operatorId);
  const lines = await query(
    `SELECT l.*,
            i.item_name,
            i.item_description,
            i.display_name,
            i.stock_unit,
            i.product_type,
            i.brand,
            i.series,
            i.to_plt,
            i.to_lyr,
            i.to_sec,
            i.to_pcs,
            b.location
     FROM cycle_count_lines l
     INNER JOIN inventory_items i ON i.item_id = l.item_id
     LEFT JOIN inventory_balances b ON b.item_id = l.item_id AND b.location_id = l.location_id
     WHERE l.record_id = $1
     ORDER BY l.confirmed_at DESC`,
    [recordId]
  );
  return { id: recordId, lines: lines.rows };
}

export async function submitCycleCount(operatorId) {
  const draft = await getCycleCountDraft(operatorId);
  await query(
    `UPDATE cycle_count_records
     SET status = 'submitted',
         submitted_at = now(),
         updated_at = now()
     WHERE id = $1
       AND operator_id = $2`,
    [draft.id, operatorId]
  );
  await writeAudit({
    actorOperatorId: operatorId,
    source: "cycle_count",
    action: "cycle_count.submit",
    details: { recordId: draft.id, lines: draft.lines.length }
  });
  return { ...draft, status: "submitted" };
}

export async function listCycleCountRecords({ limit = 50 } = {}) {
  const records = await query(
    `SELECT r.*,
            o.display_name AS operator_name,
            COUNT(l.id)::int AS line_count,
            COALESCE(SUM(ABS(COALESCE(l.variance_qty, 0))), 0) AS total_abs_variance
     FROM cycle_count_records r
     LEFT JOIN operators o ON o.id = r.operator_id
     LEFT JOIN cycle_count_lines l ON l.record_id = r.id
     WHERE r.status = 'submitted'
     GROUP BY r.id, o.display_name
     ORDER BY r.submitted_at DESC NULLS LAST, r.updated_at DESC
     LIMIT $1`,
    [Math.min(Math.max(Number(limit) || 50, 1), 200)]
  );
  const ids = records.rows.map((row) => row.id);
  if (!ids.length) return [];

  const lines = await query(
    `SELECT l.*,
            i.item_name,
            i.display_name,
            i.product_type,
            i.brand,
            i.series,
            b.location
     FROM cycle_count_lines l
     INNER JOIN inventory_items i ON i.item_id = l.item_id
     LEFT JOIN inventory_balances b ON b.item_id = l.item_id AND b.location_id = l.location_id
     WHERE l.record_id = ANY($1::bigint[])
     ORDER BY l.record_id, l.confirmed_at DESC`,
    [ids]
  );
  const linesByRecord = new Map();
  for (const line of lines.rows) {
    const list = linesByRecord.get(String(line.record_id)) || [];
    list.push(line);
    linesByRecord.set(String(line.record_id), list);
  }
  return records.rows.map((record) => ({
    ...record,
    lines: linesByRecord.get(String(record.id)) || []
  }));
}
