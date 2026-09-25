// @ts-check
(function installDeliveryRefresh(root) {
  /** @param {() => Record<string, unknown>} readContext */
  function create(readContext) {
    let context = "";
    let scope = "";
    let visit = 0;
    let scopeVisit = 0;
    let revision = 0;
    const sequences = new Map();

    function observe() {
      const snapshot = readContext();
      const next = JSON.stringify(snapshot);
      const nextScope = JSON.stringify([snapshot.account, snapshot.session, snapshot.yard, snapshot.mode, snapshot.leaving]);
      if (next !== context) {
        context = next;
        visit += 1;
      }
      if (nextScope !== scope) {
        scope = nextScope;
        scopeVisit += 1;
      }
    }

    /** @param {string} channel */
    function begin(channel) {
      observe();
      const sequence = (sequences.get(channel) || 0) + 1;
      sequences.set(channel, sequence);
      return { channel, sequence, visit, revision };
    }

    /** @param {ReturnType<typeof begin>} ticket */
    function current(ticket) {
      observe();
      return ticket.visit === visit && ticket.revision === revision
        && ticket.sequence === sequences.get(ticket.channel) && !readContext().leaving;
    }

    function invalidate() {
      revision += 1;
    }

    function cacheKey() {
      observe();
      return `${scopeVisit}:${revision}`;
    }

    function scopeKey() {
      observe();
      return String(scopeVisit);
    }

    return { begin, current, observe, invalidate, cacheKey, scopeKey };
  }
  root.OperatorDeliveryRefresh = { create };
})(/** @type {any} */ (globalThis));
