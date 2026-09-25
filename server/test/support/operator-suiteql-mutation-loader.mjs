const prefix = 'export async function suiteql(q, params = [], options = {}) {\n  const run = () => runSuiteql(q, params, options);\n';
const branch = '  if (isOperatorNetSuiteRequest()) {return run();}\n';
export const mutations = {
  rejoin_background: '',
  bypass_background: '  if (true) {return run();}\n',
  discard_validation: '  if (isOperatorNetSuiteRequest()) {return run().then(() => ({items: []}));}\n'
};

export async function load(url, context, nextLoad) {
  const result = await nextLoad(url, context);
  const name = process.env.OPERATOR_SUITEQL_MUTANT;
  if (name && url.endsWith('/src/netsuite.js')) {
    const source = String(result.source);
    if (!Object.hasOwn(mutations, name) || source.split(prefix + branch).length !== 2) {
      throw new Error('Mutation target is not unique');
    }
    process.stderr.write(`OPERATOR_SUITEQL_MUTATION:${name}\n`);
    return { ...result, source: source.replace(prefix + branch, prefix + mutations[name]) };
  }
  return result;
}
