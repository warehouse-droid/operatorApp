// Shared by the classic browser scripts and the server's ordering adapter.
(function installSmartScmLineOrder() {
  /** @param {Record<string, any>} line */
  function key(line) {
    if (line.orderKey) return line.orderKey;
    if (line.ancillaryPallet && !line.currentPurchaseOrder) return `pallet:${line.destinationLocationId ?? line.destination_location_id}`;
    return `line:${line.id}`;
  }
  /** @template {Record<string, any>} T @param {T[]} lines @param {string[] | undefined} order @returns {T[]} */
  function ordered(lines, order) {
    const ranks = new Map((Array.isArray(order) ? order : []).map((entry, index) => [entry, index]));
    return [...lines].sort((left, right) => (ranks.get(key(left)) ?? Infinity) - (ranks.get(key(right)) ?? Infinity));
  }
  /** @param {unknown} order @param {Record<string, any>[]} lines @returns {string[]} */
  function validate(order, lines) {
    const keys = new Set(lines.map(key));
    if (!Array.isArray(order) || order.length > 10000 || order.length !== lines.length
      || new Set(order).size !== order.length || order.some((entry) => typeof entry !== "string" || !keys.has(entry))) {
      throw Object.assign(new Error("Line order must contain every current material and PALLET line exactly once. Reload the load and try again."), { status: 400 });
    }
    return [...order];
  }
  /** @template T @param {T[]} items @param {string[]} keys @param {string[] | undefined} order @returns {T[]} */
  function payload(items, keys, order) {
    return ordered(items.map((item, index) => ({ orderKey: keys[index], item })), order).map((entry) => entry.item);
  }
  /** @param {Record<string, any>} row @returns {number | null} */
  function sequence(row) {
    const value = row.line_sequence_number ?? row.lineSequenceNumber
      ?? row.raw?.line_sequence_number ?? row.raw?.lineSequenceNumber;
    if (value === null || value === undefined || value === "" || typeof value === "boolean") return null;
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
  }
  globalThis.SmartScmLineOrder = Object.freeze({ key, ordered, validate, payload, sequence });
})();
