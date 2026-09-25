(function installOperatorLoadSummary(root) {
  "use strict";
  const units = [
    ["packed_pallet_qty", "to_plt", "plt"], ["packed_layer_qty", "to_lyr", "lyr"],
    ["packed_section_qty", "to_sec", "sec"], ["packed_piece_qty", "to_pcs", "pcs"]
  ];
  const number = (value) => Number.isFinite(Number(value)) ? Math.max(0, Number(value)) : 0;
  const display = (value) => String(Number(number(value).toFixed(6)));
  const converted = (line) => units.some((unit) => number(line[unit[1]]) > 0);
  function salesUnit(line) {
    return line.unit || "Qty";
  }
  const displayUnit = (value) => root.MBBS_I18N?.unit(value) ?? value;
  function format(line) {
    if (converted(line)) {
      const values = units.filter((unit) => number(line[unit[0]]) > 0.000001)
        .map((unit) => `${display(line[unit[0]])} ${displayUnit(unit[2])}`);
      if (values.length) return values.join(" ");
    }
    return number(line.packed_sales_qty) > 0.000001 ? `${display(line.packed_sales_qty)} ${displayUnit(salesUnit(line))}` : "";
  }
  function rows(lines) {
    const groups = new Map();
    for (const line of lines || []) {
      if (!format(line)) continue;
      const key = JSON.stringify([line.item_id || line.sku || line.item_name, salesUnit(line),
        ...units.map((unit) => number(line[unit[1]]))]);
      if (!groups.has(key)) groups.set(key, { ...line, packed_sales_qty: 0,
        ...Object.fromEntries(units.map((unit) => [unit[0], 0])) });
      const group = groups.get(key);
      for (const field of ["packed_sales_qty", ...units.map((unit) => unit[0])]) group[field] += number(line[field]);
    }
    return [...groups.values()].map((line) => ({ itemName: line.item_name || line.sku || "Item", quantity: format(line) }));
  }
  root.MBBS_LOAD_SUMMARY = { format, rows };
})(globalThis);
