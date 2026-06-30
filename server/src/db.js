import pg from "pg";
import { AsyncLocalStorage } from "node:async_hooks";
import { config } from "./config.js";

const { Pool } = pg;
const transactionStorage = new AsyncLocalStorage();
let savepointSeq = 0;

export const pool = new Pool({
  connectionString: config.databaseUrl
});

export async function query(text, params = []) {
  const transaction = transactionStorage.getStore();
  if (transaction?.client) return transaction.client.query(text, params);
  return pool.query(text, params);
}

export async function withTransaction(fn, { rollback = false } = {}) {
  const existing = transactionStorage.getStore();
  if (existing?.client) {
    const savepoint = `sp_${Date.now()}_${savepointSeq += 1}`;
    await existing.client.query(`SAVEPOINT ${savepoint}`);
    try {
      const result = await fn();
      await existing.client.query(rollback ? `ROLLBACK TO SAVEPOINT ${savepoint}` : `RELEASE SAVEPOINT ${savepoint}`);
      return result;
    } catch (error) {
      await existing.client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`).catch(() => null);
      throw error;
    }
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await transactionStorage.run({ client }, fn);
    await client.query(rollback ? "ROLLBACK" : "COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => null);
    throw error;
  } finally {
    client.release();
  }
}

export async function beginRollbackContext() {
  const client = await pool.connect();
  let closed = false;
  await client.query("BEGIN");
  const store = { client };
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
