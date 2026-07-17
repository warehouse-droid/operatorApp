const MIXED_UNIT_DEFINITIONS = [
  { key: "pallets", label: "PLT", directField: "processed_pallet_qty", conversionField: "to_plt" },
  { key: "layers", label: "LYR", directField: "processed_layer_qty", conversionField: "to_lyr" },
  { key: "sections", label: "SEC", directField: "processed_section_qty", conversionField: "to_sec" },
  { key: "pieces", label: "PCS", directField: "processed_piece_qty", conversionField: "to_pcs" }
];

const QUANTITY_EPSILON = 0.000001;
const SALES_QUANTITY_TOLERANCE = 0.1;

function quantity(value) {
  const number = Number(value || 0);
  return Number.isFinite(number) ? Math.max(0, number) : 0;
}

function roundedQuantity(value) {
  return Math.round(quantity(value) * 1000000) / 1000000;
}

export function yardMixedUnits(line = {}) {
  const processedQty = quantity(line.processed_qty);
  const definitions = MIXED_UNIT_DEFINITIONS.map((definition) => ({
    ...definition,
    directQty: quantity(line[definition.directField]),
    conversion: quantity(line[definition.conversionField])
  }));
  const directSalesQty = definitions.reduce(
    (sum, definition) => sum + (definition.directQty * definition.conversion),
    0
  );
  const hasDirectUnits = definitions.some((definition) => definition.directQty > 0 && definition.conversion > 0);
  const directMatchesSales = hasDirectUnits
    && Math.abs(directSalesQty - processedQty) <= SALES_QUANTITY_TOLERANCE;

  if (directMatchesSales) {
    return {
      units: definitions
        .filter((definition) => definition.directQty > 0 && definition.conversion > 0)
        .map((definition) => ({
          key: definition.key,
          label: definition.label,
          value: roundedQuantity(definition.directQty),
          conversion: definition.conversion
        })),
      remainder: 0,
      processedQty,
      usedDirectUnits: true
    };
  }

  let remainder = processedQty;
  const units = [];
  for (const definition of definitions) {
    if (definition.conversion <= 0 || remainder <= 0) continue;
    const value = Math.floor((remainder / definition.conversion) + QUANTITY_EPSILON);
    if (value <= 0) continue;
    units.push({
      key: definition.key,
      label: definition.label,
      value,
      conversion: definition.conversion
    });
    remainder = Math.max(0, remainder - (value * definition.conversion));
  }

  return {
    units,
    remainder: remainder <= SALES_QUANTITY_TOLERANCE ? 0 : roundedQuantity(remainder),
    processedQty,
    usedDirectUnits: false
  };
}
