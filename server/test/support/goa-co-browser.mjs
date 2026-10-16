import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { parse } from 'espree';

export const functionNames = [
  'canonicalDispatchOrderType', 'isAggregateDispatchCoGroup', 'flattenDispatchGroupMembers',
  'groupedOrderDependencies', 'groupedOrderDependencyLabels', 'splitParentOrderId',
  'specialOrderPalletItemQuantity', 'effectiveOrderPalletQuantity', 'normalizePoDropoffs',
  'dispatchLocationHierarchyRoot', 'normalizedPickupLocation', 'uniqueDispatchLocationLabels',
  'dispatchRelationshipPickupLocations', 'activeTransitPickupLocations', 'normalizeOrder',
  'replenishmentDependencyComplete', 'replenishmentPlacementBlockMessage',
  'normalizeReplenishmentDependentInsertIndex', 'dispatchGroupingRefs', 'dispatchOrderMatchesRefs',
  'replenishmentDependentPlacement', 'replenishmentDependencyTargetRefs', 'movementText'
];

export function browserSource() {
  const source = readFileSync(resolve('public/dispatch.js'), 'utf8');
  const ast = parse(source, { ecmaVersion: 'latest', sourceType: 'script', range: true });
  const wanted = new Set(functionNames);
  const masked = source.replace(/[^\n\r]/g, ' ').split('');
  for (const node of ast.body) {
    if (node.type !== 'FunctionDeclaration' || !wanted.delete(node.id.name)) {continue;}
    for (let index = node.range[0]; index < node.range[1]; index += 1) {masked[index] = source[index];}
  }
  if (wanted.size) {throw new Error('Missing Dispatch functions: ' + [...wanted].join(', '));}
  return masked.join('') + '\n;globalThis.goaCoFunctions = {' + functionNames.join(',') + '};';
}

export function browserFunctions(overrides = {}) {
  const context = {
    currentPlanDate: '2026-10-01',
    orderById: () => undefined,
    orderAssignment: () => ({}),
    dispatchPlannedAssignment: () => null,
    replenishmentTransferCompletionInLoad: () => null,
    replenishmentLoadPrecedence: () => null,
    comparePlanDate: (left, right) => left.localeCompare(right),
    ...overrides
  };
  vm.runInNewContext(browserSource(), context, { filename: resolve('public/dispatch.js') });
  return context.goaCoFunctions;
}

export function sampleCo(overrides = {}) {
  const dependency = { id: '265', mode: 'yard_replenishment', status: 'active',
    transferOrderRef: 'TOB01180', dispatchTargetRef: 'GOA-9611-9612', transferReceived: false };
  return {
    id: 'CO-GOA-9611-9612', type: 'CO', sourceTable: 'local_co_orders',
    sourceOrderId: 'GOA-9611-9612', sourceYard: '2967', destinationYard: '3445',
    pickupLocations: ['2967'], items: [{ itemId: 1244, quantity: 4, pieces: 4 }],
    pallets: 2, salesQty: 4, weight: 268,
    childOrders: ['SOA09611', 'SOA09612'],
    childOrderDetails: ['SOA09611', 'SOA09612'].map(id => ({
      id, type: 'SO', sourceYard: '3445', pickupLocations: ['3445'],
      orderDependencies: [dependency], dependencyWaitingForTransfer: true,
      items: [{ itemId: 1244, quantity: 4, pieces: 4 }]
    })),
    ...overrides
  };
}
