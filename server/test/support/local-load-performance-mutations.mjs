export const mutants = {
  scanAllSales: ["WHERE l.sales_order_id = $1\n       UNION ALL", "WHERE true\n       UNION ALL"],
  scanAllTransfers: ["WHERE line_stage = 'outbound' AND transfer_order_id = $1", "WHERE line_stage = 'outbound'"],
  wrongSalesOrder: ["WHERE l.sales_order_id = $1\n       UNION ALL", "WHERE l.sales_order_id = $1 + 1\n       UNION ALL"],
  wrongTransferOrder: ["WHERE line_stage = 'outbound' AND transfer_order_id = $1", "WHERE line_stage = 'outbound' AND transfer_order_id = $1 + 1"]
};

export async function load(url, context, nextLoad) {
  const result = await nextLoad(url, context);
  const mutant = mutants[process.env.LOCAL_LOAD_PERF_MUTANT];
  if (!mutant || !url.endsWith("/src/delivery-repository.js")) {return result;}
  const [from, to] = mutant;
  const source = String(result.source);
  if (source.split(from).length !== 2) {throw new Error("Invalid mutation anchor");}
  return { ...result, source: source.replace(from, to) };
}
