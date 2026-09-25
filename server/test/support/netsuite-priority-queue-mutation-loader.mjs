export const mutations = {
  fifth_slot: ['netsuite-request-queue-store.js', 'NETSUITE_REQUEST_LIMIT = 4', 'NETSUITE_REQUEST_LIMIT = 5'],
  two_background: ['netsuite-request-queue-store.js', 'NETSUITE_BACKGROUND_LIMIT = 1', 'NETSUITE_BACKGROUND_LIMIT = 2'],
  background_first: ['netsuite-request-queue-store.js', 'ORDER BY priority DESC, sequence', 'ORDER BY priority ASC, sequence'],
  leak_slot: ['netsuite-request-scheduler.js', 'await store.release(id).catch', 'await Promise.resolve().catch'],
  discard_result: ['netsuite-request-scheduler.js', 'return await work(requestSignal);', 'await work(requestSignal); return undefined;']
};

export async function load(url, context, nextLoad) {
  const result = await nextLoad(url, context);
  const name = process.env.NETSUITE_PRIORITY_MUTANT, mutation = mutations[name];
  if (mutation && url.endsWith(`/src/${mutation[0]}`)) {
    const source = String(result.source);
    if (source.split(mutation[1]).length !== 2) { throw new Error(`Mutation anchor must be unique: ${name}`); }
    process.stderr.write(`NETSUITE_PRIORITY_MUTATION:${name}\n`);
    return { ...result, source: source.replace(mutation[1], mutation[2]) };
  }
  return result;
}
