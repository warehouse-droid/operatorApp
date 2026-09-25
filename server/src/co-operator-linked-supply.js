// @ts-check
import { applyOperatorLinkedQuantityProjection } from "./operator-linked-quantity-domain.js";

/** @typedef {"quantity" | "pallet_qty" | "layer_qty" | "section_qty" | "piece_qty"} QuantityField */
/** @type {ReadonlyArray<readonly [QuantityField, string]>} */
const QUANTITIES = Object.freeze([
  ["quantity", "sales"], ["pallet_qty", "pallets"], ["layer_qty", "layers"],
  ["section_qty", "sections"], ["piece_qty", "pieces"]
]);

/**
 * Canonical CO quantities already exclude direct TO supply. Restore the saved
 * original only for the shared Operator projection, never for transport cargo.
 * Loaded quantities describe actual cargo and cannot infer a supply allocation.
 * @param {Record<string, any>} line
 * @param {{loaded?: boolean}} options
 */
export function projectCoOperatorLinkedSupply(line, options = {}) {
  const saved = line.raw?.coDirectToRequirement;
  if (options.loaded || !saved) {return line;}
  const residual = applyOperatorLinkedQuantityProjection(line);
  const original = applyOperatorLinkedQuantityProjection(Object.fromEntries(
    QUANTITIES.map(([field]) => [field, saved[field]])
  ));
  const required = { ...line };
  /** @type {Record<string, number>} */
  const linkedDirectTo = {};
  for (const [field, unit] of QUANTITIES) {
    required[field] = Math.max(original[field], residual[field]);
    linkedDirectTo[unit] = Number((required[field] - residual[field]).toFixed(6));
  }
  return applyOperatorLinkedQuantityProjection(required, { linkedDirectTo });
}
