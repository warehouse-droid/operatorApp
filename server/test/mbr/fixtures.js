export const fields = (overrides = {}) => ({
  effectiveDate: '2026-10-13', lessee: 'Acme Construction Ltd.',
  equipmentModel: 'STR1000H', serialNumber: 'VLGST1KHAT0610007',
  rentalStart: '2026-10-15', rentalEnd: '2026-10-22',
  pickupLocation: '90 Belfield Road, Toronto', returnLocation: '90 Belfield Road, Toronto',
  dailyRate: '250.00', weeklyRate: '1000.00', monthlyRate: '3000.00',
  securityDeposit: '500.00', expiryDays: 3, ...overrides
});
