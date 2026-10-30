/**
 * @NApiVersion 2.1
 */
define(['./ppa_core'], core => {
  'use strict';
  function provenance(row) {
    return JSON.stringify([row.qty, row.rate, row.sources.slice().sort()]);
  }
  function protectConsumed(oldRows, rows) {
    for (const old of oldRows) {
      if (old.pending + old.refunded === 0) { continue; }
      const next = rows.find(row => row.key === old.key);
      if (!next || provenance(old) !== provenance(next)) {
        throw new Error(`CONSUMED_SOURCE_CHANGED:${old.key}`);
      }
    }
  }
  function persist(io, existing, result) {
    for (const row of result.allocations) { row.id = io.putAllocation(row, false, result.issues); }
    for (const row of result.events) {
      const allocation = result.allocations.find(a => a.key === row.allocation);
      io.putEvent({ ...row, allocationId: allocation.id });
    }
    for (const row of existing.events) {
      if (!result.events.some(event => event.key === row.key)) { io.reverseEvent(row); }
    }
    for (const row of existing.allocations) {
      if (!result.allocations.some(allocation => allocation.key === row.key)) { io.retireAllocation(row); }
    }
  }
  function refresh(io, customer, dryRun) {
    if (dryRun) { return core.build(io.snapshot(customer)); }
    io.ensureWriter();
    io.invalidate(customer);
    try {
      const existing = io.existing(customer);
      const input = io.snapshot(customer);
      const result = core.build(input);
      protectConsumed(existing.allocations, result.allocations);
      io.budget(existing, result);
      if (io.version(customer) !== input.stamp) { throw new Error('SOURCE_CHANGED'); }
      persist(io, existing, result);
      if (io.version(customer) !== input.stamp) { throw new Error('SOURCE_CHANGED'); }
      if (result.verified) {
        for (const row of result.allocations) { io.publish(row); }
      }
      return result;
    } catch (error) {
      // These rows are a cache. Never leave a known failed rebuild marked verified.
      io.invalidate(customer);
      throw error;
    }
  }
  return { refresh };
});
