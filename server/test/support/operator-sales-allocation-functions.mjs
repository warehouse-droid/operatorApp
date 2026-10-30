import { destinationFunctions } from './dispatch-po-line-destination-functions.mjs';

export const operatorSalesUi = destinationFunctions('../../public/operator.js', [
  'lineHasConversion', 'shouldUseSalesQuantity', 'lineUnitsToSalesQty', 'lineRequiredSalesQty',
  'operatorRoundedSalesQuantity', 'operatorLoadedUnitCount', 'operatorPackUnitCapacity',
  'wholeUnitsFromSalesQty', 'unitConversion', 'explicitUnitQty', 'unitRequiredLimit',
  'loadedUnits', 'preferredPackUnits', 'packingLoadedSalesQty', 'convertedRemainingPack',
  'loadedValue', 'hasRemainingQty', 'hasValue', 'hasCustomPackQty', 'requiredValue', 'packedValue',
  'remainingValue', 'renderLinkedSupplyBreakdown'
], { qty: value => Number(value) || 0, displayQty: String, displayUnit: String,
  escapeHtml: String, t: (_key, fallback) => fallback });

export const operatorSalesServer = destinationFunctions('../../src/delivery-repository.js', [
  'normalizeNumber', 'normalizeQuantity', 'positiveQuantity', 'hasConversion', 'lineUnitsToSalesQuantity', 'lineRequiredSalesQuantity'
]);
