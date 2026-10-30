const mutations = {
  density: ["/src/mbt/aggregate-density.js", "= 2_600;", "= 1_300;"],
  prefix: ["/src/mbt/customer-charge-calculator.js", "/^[A-Z0-9][A-Z0-9_]{0,63}$/u.test(itemCode)", "/^AGG_[A-Z0-9_]+$/u.test(itemCode)"],
  length: ["/src/mbt/customer-charge-calculator.js", "/^[A-Z0-9][A-Z0-9_]{0,63}$/u.test(itemCode)", "/^[A-Z0-9][A-Z0-9_]*$/u.test(itemCode)"],
  duplicate: ["/src/mbt/customer-charge-calculator.js", " || itemCodes.has(itemCode)", ""],
  historical: ["/src/mbt/customer-charge-calculator.js", "positiveInteger(line.densityLbsPerYard, `Aggregate line ${index + 1} density`)", "2600"]
};

export async function load(url, context, nextLoad) {
  const result = await nextLoad(url, context);
  const mutation = mutations[process.env.MBT_AGGREGATE_MUTANT];
  if (!mutation || !url.endsWith(mutation[0])) {
    return result;
  }
  const source = String(result.source);
  if (source.split(mutation[1]).length !== 2) {
    throw new Error("Mutation must match exactly once");
  }
  return { ...result, source: source.replace(mutation[1], mutation[2]) };
}
