/**
 * Read the existing MB - Pallet balance of clients search for one customer.
 * This script does not create/update records or save changes to the search.
 *
 * @NApiVersion 2.1
 * @NScriptType Restlet
 * @NModuleScope SameAccount
 */
define(['N/search', 'N/error'], (search, error) => {
  const SEARCH_ID = 'customsearch503';
  const MAX_ROWS = 50;

  function fail(name, message) {
    throw error.create({ name, message, notifyOff: true });
  }

  function get(params = {}) {
    const raw = params.customerId;
    if (!['string', 'number'].includes(typeof raw)
      || !/^[1-9]\d*$/.test(String(raw))
      || !Number.isSafeInteger(Number(raw))) {
      fail('INVALID_CUSTOMER_ID', 'customerId must be a positive NetSuite internal ID.');
    }
    const customerId = String(raw);
    const loaded = search.load({ id: SEARCH_ID });
    const original = loaded.filterExpression;
    const customerFilter = ['entity', search.Operator.ANYOF, customerId];
    // Group the entire original expression before adding AND. This preserves
    // existing OR conditions and all saved location/date/item criteria.
    loaded.filterExpression = original && original.length
      ? [original, 'and', customerFilter]
      : [customerFilter];

    const columns = loaded.columns;
    const results = loaded.run().getRange({ start: 0, end: MAX_ROWS + 1 });
    if (results.length > MAX_ROWS) {
      fail('PALLET_SEARCH_TOO_MANY_ROWS',
        'More than 50 rows for this customer. Review the report grouping before using it as a balance.');
    }
    return {
      version: 1,
      savedSearchId: SEARCH_ID,
      customerId,
      generatedAt: new Date().toISOString(),
      found: results.length > 0,
      rowCount: results.length,
      columns: columns.map((column, index) => ({
        index,
        name: column.name,
        label: column.label || '',
        join: column.join || '',
        summary: column.summary || '',
        formula: column.formula || '',
        sort: column.sort || ''
      })),
      // Column objects disambiguate multiple formula columns with the same name.
      // Preserve raw values; selecting/validating the balance column is an
      // integration step after inspecting this search's real output.
      rows: results.map(result => columns.map(column => result.getValue(column)))
    };
  }

  return { get };
});
