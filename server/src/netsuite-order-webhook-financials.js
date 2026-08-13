export function netSuiteOrderWebhookLineFinancials(line = {}) {
  const source = line && typeof line === "object" && !Array.isArray(line) ? line : {};
  return {
    rate: source.rate ?? source.unitPrice ?? source.unit_price,
    amount: source.amount ?? source.foreignAmount ?? source.foreign_amount,
    netsuite_closed: source.netsuite_closed ?? source.closed
  };
}
