export function palletSearchResult(customerId, balance = 13) {
  return {
    version: 1,
    savedSearchId: 'customsearch503',
    customerId: String(customerId),
    generatedAt: new Date().toISOString(),
    found: true,
    rowCount: 1,
    columns: [
      { index: 0, name: 'entity', label: 'Name', join: '', summary: 'GROUP', formula: '', sort: 'ASC' },
      { index: 1, name: 'mainline', label: '*', join: '', summary: 'GROUP', formula: '', sort: 'NONE' },
      { index: 2, name: 'quantity', label: 'Returnable Quantity', join: '', summary: 'SUM', formula: '', sort: 'NONE' },
      { index: 3, name: 'mainline', label: '*', join: '', summary: 'GROUP', formula: '', sort: 'NONE' },
      { index: 4, name: 'phone', label: 'Phone', join: 'customerMain', summary: 'GROUP', formula: '', sort: 'NONE' }
    ],
    rows: [[String(customerId), '&nbsp;', String(balance), '&nbsp;', '']]
  };
}
