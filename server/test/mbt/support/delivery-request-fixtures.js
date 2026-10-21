export const sales = { id: 'delivery-sales', role: 'sales', yardLocationIds: [1, 15] };
export const colleague = { ...sales, id: 'delivery-colleague' };
export const dispatcher = { id: 'delivery-dispatch', role: 'dispatcher' };
export const pricing = (overrides = {}) => {
  const { originYardCode = '3445', totalUnits = 27, outbounds, ...rest } = overrides;
  const yards = outbounds || [{ originYardCode, totalUnits }];
  return { requestingYardLocationId: 1, loadType: 'pos',
    pricingOriginYardCode: yards[0]?.originYardCode || '3445',
    totalUnits: outbounds ? yards.reduce((sum, yard) => sum + yard.totalUnits, 0) : totalUnits,
    outbounds: yards, deliveryAddress: '100 Test Road, Toronto, ON', binTypeCode: null, ...rest };
};
export const window = (overrides = {}) => ({ date: '2028-10-10', start: '09:00', end: '12:00', ...overrides });
export function graph(loadType = 'pos') {
  const pos = loadType === 'pos';
  const bounds = [0, 30000, 50000, 65000, 75000];
  const amounts = pos ? [23500, 28500, 33500, 38500, 700] : [10000, 15000, 20000, 25000, 700];
  return { rateCardCode: pos ? 'DELIVERY_CHARGE_MBBS' : 'DELIVERY_CHARGE_MBT_2026_RATE',
    rateCardVersionId: pos ? '11111111-1111-4111-8111-111111111111' : '22222222-2222-4222-8222-222222222222',
    versionNumber: pos ? 4 : 1, displayName: pos ? 'MBBS' : 'MBT', currency: 'CAD',
    bands: bounds.map((minimumMetres, index) => ({ rateDistanceBandId: `band-${loadType}-${index}`,
      itemCode: pos ? 'DELIVERY_CHARGE_MBBS' : 'DELIVERY_CHARGE_MBT',
      serviceCode: pos ? 'mbbs_cross_charge' : 'delivery', binTypeCode: pos ? null : '14YD',
      minimumMetres, maximumMetres: bounds[index + 1] ?? null, sequenceNumber: index + 1,
      amountMinor: amounts[index], currency: 'CAD', boundaryRule: 'upper_inclusive',
      pricingBasis: index === 4 ? 'per_km' : 'flat', originYardCodes: ['3445', '2967'],
      baseAmountMinor: pos && index === 4 ? 38500 : null,
      includedMetres: pos && index === 4 ? 75000 : null, downtownSurchargeMinor: 0 })) };
}
export const request = (overrides = {}) => ({ id: 1, requestRef: 'DR-000001', ...pricing(), customerId: null,
  customerName: '', remarks: '', quote: { totalAmountMinor: 47000 }, requestedWindow: window(),
  proposedWindow: null, confirmedWindow: null, salesOrderRefs: [], approvalExpiresAt: null,
  reminderAt: null, reminderSentAt: null, securedAt: null, status: 'submitted', revision: 1, ...overrides });
export const clock = { now: '2028-10-01T12:00:00.000Z', settings: { pos: 26, bin: 1, approvalHours: 3, reminderHours: 1 } };
