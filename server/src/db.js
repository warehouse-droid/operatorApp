import pg from "pg";
import { AsyncLocalStorage } from "node:async_hooks";
import { config } from "./config.js";

const { Pool } = pg;
const transactionStorage = new AsyncLocalStorage();
let savepointSeq = 0;

export const pool = new Pool({
  connectionString: config.databaseUrl,
  options: "-c jit=off"
});

export async function query(text, params = []) {
  const transaction = transactionStorage.getStore();
  if (transaction?.client) return transaction.client.query(text, params);
  return pool.query(text, params);
}

export function hasActiveTransaction() {
  return Boolean(transactionStorage.getStore()?.client);
}

export function afterTransactionCommit(callback) {
  if (typeof callback !== "function") throw new TypeError("A post-commit callback is required.");
  const transaction = transactionStorage.getStore();
  if (!transaction?.client) {
    callback();
    return false;
  }
  transaction.afterCommit ||= [];
  transaction.afterCommit.push(callback);
  return true;
}

export async function withTransaction(fn, { rollback = false } = {}) {
  const existing = transactionStorage.getStore();
  if (existing?.client) {
    const savepoint = `sp_${Date.now()}_${savepointSeq += 1}`;
    const callbackStart = existing.afterCommit?.length || 0;
    await existing.client.query(`SAVEPOINT ${savepoint}`);
    try {
      const result = await fn();
      await existing.client.query(rollback ? `ROLLBACK TO SAVEPOINT ${savepoint}` : `RELEASE SAVEPOINT ${savepoint}`);
      if (rollback && existing.afterCommit?.length > callbackStart) {
        existing.afterCommit.splice(callbackStart);
      }
      return result;
    } catch (error) {
      await existing.client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`).catch(() => null);
      if (existing.afterCommit?.length > callbackStart) existing.afterCommit.splice(callbackStart);
      throw error;
    }
  }

  const client = await pool.connect();
  let result;
  let callbacks = [];
  try {
    await client.query("BEGIN");
    const transaction = { client, afterCommit: [] };
    result = await transactionStorage.run(transaction, fn);
    await client.query(rollback ? "ROLLBACK" : "COMMIT");
    if (!rollback) callbacks = [...transaction.afterCommit];
  } catch (error) {
    await client.query("ROLLBACK").catch(() => null);
    throw error;
  } finally {
    client.release();
  }
  for (const callback of callbacks) {
    try {
      await callback();
    } catch {
      // The database is already committed. Notification failures must not make
      // callers retry durable operational work.
    }
  }
  return result;
}

export async function beginRollbackContext() {
  const client = await pool.connect();
  let closed = false;
  await client.query("BEGIN");
  const store = { client, afterCommit: [] };
  return {
    run(fn) {
      return transactionStorage.run(store, fn);
    },
    async rollback() {
      if (closed) return;
      closed = true;
      try {
        await client.query("ROLLBACK");
      } finally {
        client.release();
      }
    }
  };
}

export async function closeDb() {
  await pool.end();
}
