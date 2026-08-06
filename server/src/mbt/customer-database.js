// @ts-check

/**
 * @typedef {object} CustomerQueryResult
 * @property {Record<string, unknown>[]} rows
 * @property {number | null | undefined} [rowCount]
 */

/**
 * @typedef {object} CustomerDatabase
 * @property {(sql: string, params?: unknown[]) => Promise<CustomerQueryResult>} query
 * @property {() => void} [release]
 */

/** @param {unknown} value @returns {CustomerDatabase} */
export function customerDatabase(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("A customer database query boundary is required.");
  }
  const candidate = /** @type {{query?: unknown}} */ (value);
  if (typeof candidate.query !== "function") {
    throw new TypeError("A customer database query boundary is required.");
  }
  return /** @type {CustomerDatabase} */ (value);
}

/**
 * Pools own a transaction here. A query-only boundary is assumed to be an
 * existing AsyncLocalStorage transaction and is never escaped.
 *
 * @template T
 * @param {unknown} database
 * @param {(client: CustomerDatabase) => Promise<T>} operation
 * @returns {Promise<T>}
 */
export async function withCustomerTransaction(database, operation) {
  const boundary = customerDatabase(database);
  const connect = /** @type {{connect?: unknown}} */ (database).connect;
  if (typeof connect !== "function") {
    return operation(boundary);
  }
  const client = customerDatabase(await connect.call(database));
  try {
    await client.query("BEGIN");
    const result = await operation(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release?.();
  }
}
