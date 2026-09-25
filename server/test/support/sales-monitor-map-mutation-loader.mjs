export const allowedLine = '  if (req.method === "POST" && req.path === "/maps/browser-session" && operatorHasAnyRole(req.operator, ["sales"])) return next();';
export const mutants = [
  ['deny-map', allowedLine.replace('req.method === "POST"', 'false')],
  ['all-posts', allowedLine.replace('req.path === "/maps/browser-session" && ', '')],
  ['all-methods', allowedLine.replace('req.method === "POST" && ', '')],
  ['all-staff', allowedLine.replace(' && operatorHasAnyRole(req.operator, ["sales"])', '')]
];

export async function load(url, context, nextLoad) {
  const result = await nextLoad(url, context);
  if (!url.endsWith('/src/server.js') || !process.env.SALES_MONITOR_MUTATION) { return result; }
  const source = String(result.source);
  const mutant = mutants.find(([name]) => name === process.env.SALES_MONITOR_MUTATION);
  if (!mutant || source.split(allowedLine).length !== 2) { throw new Error('Mutation target is not unique'); }
  console.error(`SALES_MONITOR_MUTATION_APPLIED:${mutant[0]}`);
  return { ...result, source: source.replace(allowedLine, mutant[1]) };
}
