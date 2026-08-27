// @ts-check

const EPSILON = 0.000001;
/** @typedef {{pallets: number, layers: number, sections: number, pieces: number, sales: number}} QuantitySet */
/** @type {ReadonlyArray<keyof QuantitySet>} */
const UNITS = Object.freeze(["pallets", "layers", "sections", "pieces", "sales"]);

/** @param {string} message */
function quantityError(message) {
  return Object.assign(new Error(message), {
    status: 409,
    code: "LINKED_QUANTITY_INVALID"
  });
}

/** @param {unknown} value @param {string} label */
function quantity(value, label) {
  if (value === null || value === undefined || value === "") {return 0;}
  const retained = typeof value === "string" ? value.replaceAll(",", "") : value;
  const number = Number(retained);
  if (!Number.isFinite(number) || number < 0) {
    throw quantityError(`${label} must be a finite nonnegative quantity.`);
  }
  return Number(number.toFixed(6));
}

/** @param {Record<string, any> | null | undefined} input @param {string} label @returns {QuantitySet} */
// Quantity aliases are an explicit compatibility boundary for PO, TO, and Operator records.
// eslint-disable-next-line complexity
function quantitySet(input, label) {
  const source = input || {};
  return {
    pallets: quantity(source.pallets ?? source.pallet_qty ?? source.allocated_pallet_qty, `${label} pallets`),
    layers: quantity(source.layers ?? source.layer_qty ?? source.allocated_layer_qty, `${label} layers`),
    sections: quantity(source.sections ?? source.section_qty ?? source.allocated_section_qty, `${label} sections`),
    pieces: quantity(source.pieces ?? source.piece_qty ?? source.allocated_piece_qty, `${label} pieces`),
    sales: quantity(
      source.sales
        ?? source.salesQty
        ?? source.sales_qty
        ?? source.allocated_sales_qty
        ?? source.allocated_quantity,
      `${label} sales quantity`
    )
  };
}

/** @param {QuantitySet} left @param {QuantitySet} right @returns {QuantitySet} */
function add(left, right) {
  return /** @type {QuantitySet} */ (Object.fromEntries(
    UNITS.map((unit) => [unit, Number((left[unit] + right[unit]).toFixed(6))])
  ));
}

/** @param {QuantitySet} total @param {Record<string, any>} input @param {string} label @returns {QuantitySet} */
function addInput(total, input, label) {
  return add(total, quantitySet(input, label));
}

/** @returns {QuantitySet} */
function emptyQuantitySet() {
  return { pallets: 0, layers: 0, sections: 0, pieces: 0, sales: 0 };
}

/**
 * Reduce only active PO allocations and non-cancelled direct-to-customer TO
 * allocations. Yard replenishment remains physical Operator work.
 *
 * @param {{poAllocations?: Record<string, any>[], toAllocations?: Record<string, any>[]}} input
 */
// Each lifecycle/mode branch is part of the auditable linked-supply policy.
// eslint-disable-next-line complexity
export function sumActiveLinkedQuantities({ poAllocations = [], toAllocations = [] } = {}) {
  let linkedPo = emptyQuantitySet();
  for (const allocation of Array.isArray(poAllocations) ? poAllocations : []) {
    if (String(allocation?.status || "").trim().toLowerCase() !== "active") {continue;}
    linkedPo = addInput(linkedPo, allocation, "Link PO allocation");
  }
  let linkedDirectTo = emptyQuantitySet();
  for (const allocation of Array.isArray(toAllocations) ? toAllocations : []) {
    const status = String(allocation?.status || "").trim().toLowerCase();
    const mode = String(allocation?.dependencyMode ?? allocation?.dependency_mode ?? "").trim().toLowerCase();
    if (status === "cancelled" || mode !== "direct_to_customer") {continue;}
    linkedDirectTo = addInput(linkedDirectTo, allocation, "Direct Link TO allocation");
  }
  return { linkedPo, linkedDirectTo };
}

/**
 * @param {{required?: Record<string, any>, linkedPo?: Record<string, any>, linkedDirectTo?: Record<string, any>}} input
 */
export function projectOperatorLinkedQuantities({ required = {}, linkedPo = {}, linkedDirectTo = {} } = {}) {
  const original = quantitySet(required, "Dispatch target");
  const po = quantitySet(linkedPo, "Link PO");
  const directTo = quantitySet(linkedDirectTo, "Direct Link TO");
  const linkedTotal = add(po, directTo);
  const errors = [];
  const operatorRequired = emptyQuantitySet();
  for (const unit of UNITS) {
    if (linkedTotal[unit] > original[unit] + EPSILON) {
      errors.push({
        code: "LINKED_QUANTITY_EXCEEDS_TARGET",
        unit,
        required: original[unit],
        linked: linkedTotal[unit]
      });
    }
    operatorRequired[unit] = Number(Math.max(original[unit] - linkedTotal[unit], 0).toFixed(6));
  }
  const hasOriginal = UNITS.some((unit) => original[unit] > EPSILON);
  const noYardLoadRequired = hasOriginal
    && UNITS.every((unit) => original[unit] <= EPSILON || operatorRequired[unit] <= EPSILON);
  return {
    original,
    linkedPo: po,
    linkedDirectTo: directTo,
    linkedTotal,
    operatorRequired,
    noYardLoadRequired,
    blocked: errors.length > 0,
    errors
  };
}

/** @param {QuantitySet} original @param {QuantitySet} po @param {QuantitySet} directTo @param {QuantitySet} total @param {QuantitySet} residual */
function breakdown(original, po, directTo, total, residual) {
  return Object.fromEntries(UNITS.map((unit) => [unit, {
    original: original[unit],
    linkedPo: po[unit],
    linkedDirectTo: directTo[unit],
    linkedTotal: total[unit],
    operatorRequired: residual[unit]
  }]));
}

/**
 * Preserve source quantities while retaining the current residual field names
 * used by Operator clients. The legacy `po_allocated_*` fields intentionally
 * remain a combined PO + direct-TO compatibility alias.
 *
 * @param {Record<string, any>} line
 * @param {{linkedPo?: Record<string, any>, linkedDirectTo?: Record<string, any>}} linked
 */
export function applyOperatorLinkedQuantityProjection(line, linked = {}) {
  const projection = projectOperatorLinkedQuantities({
    required: {
      pallets: line?.pallet_qty,
      layers: line?.layer_qty,
      sections: line?.section_qty,
      pieces: line?.piece_qty,
      sales: line?.quantity
    },
    linkedPo: linked.linkedPo || {},
    linkedDirectTo: linked.linkedDirectTo || {}
  });
  const { original, linkedPo, linkedDirectTo, linkedTotal, operatorRequired } = projection;
  return {
    ...line,
    original_pallet_qty: original.pallets,
    original_layer_qty: original.layers,
    original_section_qty: original.sections,
    original_piece_qty: original.pieces,
    original_quantity: original.sales,
    linked_po_pallet_qty: linkedPo.pallets,
    linked_po_layer_qty: linkedPo.layers,
    linked_po_section_qty: linkedPo.sections,
    linked_po_piece_qty: linkedPo.pieces,
    linked_po_sales_qty: linkedPo.sales,
    linked_direct_to_pallet_qty: linkedDirectTo.pallets,
    linked_direct_to_layer_qty: linkedDirectTo.layers,
    linked_direct_to_section_qty: linkedDirectTo.sections,
    linked_direct_to_piece_qty: linkedDirectTo.pieces,
    linked_direct_to_sales_qty: linkedDirectTo.sales,
    linked_allocated_pallet_qty: linkedTotal.pallets,
    linked_allocated_layer_qty: linkedTotal.layers,
    linked_allocated_section_qty: linkedTotal.sections,
    linked_allocated_piece_qty: linkedTotal.pieces,
    linked_allocated_sales_qty: linkedTotal.sales,
    po_allocated_pallet_qty: linkedTotal.pallets,
    po_allocated_layer_qty: linkedTotal.layers,
    po_allocated_section_qty: linkedTotal.sections,
    po_allocated_piece_qty: linkedTotal.pieces,
    po_allocated_sales_qty: linkedTotal.sales,
    operator_required_pallet_qty: operatorRequired.pallets,
    operator_required_layer_qty: operatorRequired.layers,
    operator_required_section_qty: operatorRequired.sections,
    operator_required_piece_qty: operatorRequired.pieces,
    operator_required_sales_qty: operatorRequired.sales,
    pallet_qty: operatorRequired.pallets,
    layer_qty: operatorRequired.layers,
    section_qty: operatorRequired.sections,
    piece_qty: operatorRequired.pieces,
    quantity: operatorRequired.sales,
    quantity_breakdown: breakdown(original, linkedPo, linkedDirectTo, linkedTotal, operatorRequired),
    no_yard_load_required: projection.noYardLoadRequired,
    linked_supply_label: projection.noYardLoadRequired ? "No yard load required—direct supply" : "",
    linked_quantity_blocked: projection.blocked,
    linked_quantity_errors: projection.errors
  };
}
