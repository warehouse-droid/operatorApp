const EPSILON = 0.000001;

function number(value) {
  const parsed = Number(String(value ?? 0).replaceAll(",", ""));
  return Number.isFinite(parsed) ? Math.abs(parsed) : 0;
}

function nullableNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(String(value).replaceAll(",", ""));
  return Number.isFinite(parsed) ? parsed : null;
}

export function dependencyQuantityConversionDisplay(quantity, line = {}) {
  let remaining = number(quantity);
  const result = { palletQty: 0, layerQty: 0, sectionQty: 0, pieceQty: 0 };
  const conversions = [
    ["palletQty", number(line.toPlt ?? line.to_plt)],
    ["layerQty", number(line.toLyr ?? line.to_lyr)],
    ["sectionQty", number(line.toSec ?? line.to_sec)],
    ["pieceQty", number(line.toPcs ?? line.to_pcs)]
  ];
  let hasConversion = false;
  let smallestConversion = null;
  for (const [field, conversion] of conversions) {
    if (!conversion || remaining <= EPSILON) continue;
    hasConversion = true;
    if (!smallestConversion || conversion < smallestConversion.conversion) {
      smallestConversion = { field, conversion };
    }
    const units = Math.floor((remaining / conversion) + EPSILON);
    if (units > 0) {
      result[field] = units;
      remaining = Math.max(0, Number((remaining - (units * conversion)).toFixed(6)));
    }
  }
  if (hasConversion && remaining > EPSILON && smallestConversion) {
    result[smallestConversion.field] = Number((
      result[smallestConversion.field] + (remaining / smallestConversion.conversion)
    ).toFixed(6));
  }
  if (!hasConversion) result.pieceQty = number(quantity);
  return result;
}

export function resolveDependencyLineContributions(lines = []) {
  const remainingByItem = new Map();
  for (const line of lines || []) {
    if ((line.lineRole || "sales_allocation") !== "sales_allocation") continue;
    const itemKey = String(line.itemId || line.itemName || line.id);
    if (remainingByItem.has(itemKey)) continue;
    const outbound = nullableNumber(line.transferOutboundQuantity);
    const receiving = nullableNumber(line.transferReceivingQuantity);
    remainingByItem.set(itemKey, outbound ?? receiving);
  }
  return (lines || []).map((line) => {
    const allocated = number(line.allocatedQuantity);
    if ((line.lineRole || "sales_allocation") !== "sales_allocation") {
      return {
        ...line,
        effectiveAllocatedQuantity: allocated,
        effectivePalletQty: number(line.palletQty),
        effectiveLayerQty: number(line.layerQty),
        effectiveSectionQty: number(line.sectionQty),
        effectivePieceQty: number(line.pieceQty),
        quantityLimited: false
      };
    }
    const itemKey = String(line.itemId || line.itemName || line.id);
    const remaining = remainingByItem.get(itemKey);
    const effective = remaining === null || remaining === undefined
      ? allocated
      : Math.min(allocated, Math.max(0, number(remaining)));
    if (remaining !== null && remaining !== undefined) {
      remainingByItem.set(itemKey, Math.max(0, number(remaining) - effective));
    }
    const limited = effective + EPSILON < allocated;
    const display = limited ? dependencyQuantityConversionDisplay(effective, line) : {
      palletQty: number(line.palletQty),
      layerQty: number(line.layerQty),
      sectionQty: number(line.sectionQty),
      pieceQty: number(line.pieceQty)
    };
    return {
      ...line,
      effectiveAllocatedQuantity: effective,
      effectivePalletQty: display.palletQty,
      effectiveLayerQty: display.layerQty,
      effectiveSectionQty: display.sectionQty,
      effectivePieceQty: display.pieceQty,
      quantityLimited: limited
    };
  });
}

export function dependencyHasEffectiveMaterial(dependency = {}) {
  const materialLines = (dependency.lines || []).filter((line) =>
    (line.lineRole || "sales_allocation") === "sales_allocation"
  );
  if (!materialLines.length) return true;
  return materialLines.some((line) =>
    number(line.effectiveAllocatedQuantity ?? line.allocatedQuantity) > EPSILON
  );
}
