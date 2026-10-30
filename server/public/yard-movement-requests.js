/* global window */
// Pending reads are shared only within one page. Completed data is never cached.
window.MBBSMovementReads = {
  /** @param {(path: string, options: {signal: AbortSignal}) => Promise<unknown>} request */
  create(request) {
    const pending = new Map();
    /** @param {string} channel */
    function cancel(channel) {
      const entry = pending.get(channel);
      pending.delete(channel);
      entry?.controller.abort();
    }
    /**
     * @param {string} channel
     * @param {string} path
     * @param {(data: unknown) => unknown} apply
     */
    function run(channel, path, apply) {
      const current = pending.get(channel);
      if (current?.path === path) return current.promise;
      cancel(channel);
      const entry = { path, controller: new AbortController(), promise: Promise.resolve() };
      pending.set(channel, entry);
      entry.promise = (async () => {
        try {
          const data = await request(path, { signal: entry.controller.signal });
          if (pending.get(channel) === entry) await apply(data);
        } catch (error) {
          if (pending.get(channel) === entry) throw error;
        } finally {
          if (pending.get(channel) === entry) pending.delete(channel);
        }
      })();
      return entry.promise;
    }
    return { run, cancel, pending: (/** @type {string} */ channel) => pending.has(channel) };
  }
};
