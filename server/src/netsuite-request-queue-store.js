// @ts-check
import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { config } from './config.js';

// Separate, short transactions avoid deadlock when business transactions wait
// for NetSuite while already holding connections in the application's DB pool.
const queuePool = new pg.Pool({ connectionString: config.databaseUrl, max: 2,
  connectionTimeoutMillis: 5000, idleTimeoutMillis: 1000, allowExitOnIdle: true,
  options: '-c jit=off -c statement_timeout=5000 -c lock_timeout=2000' });
queuePool.on('error', () => { console.warn('NetSuite request queue database connection failed.'); });

export const NETSUITE_REQUEST_LIMIT = 4;
export const NETSUITE_BACKGROUND_LIMIT = 1;
const WAITING_LEASE_MS = 30000;
const RECOVERY_GRACE_MS = 30000;

/** @param {string} code @param {string} message */
export function netSuiteQueueError(code, message) { return Object.assign(new Error(message), { code, status: 503 }); }

/** @template T @param {(client: import('pg').PoolClient) => Promise<T>} work */
async function locked(work) {
  const client = await queuePool.connect();
  try {
    await client.query('BEGIN');
    // Shared by every app and worker process connected to this database.
    await client.query('SELECT pg_advisory_xact_lock(728491, 1)');
    await client.query('DELETE FROM netsuite_request_queue WHERE expires_at <= clock_timestamp()');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally { client.release(); }
}

export const netSuiteRequestQueueStore = {
  /** @param {'operator' | 'background'} priority */
  enqueue(priority) {
    return locked(async client => {
      const count = await client.query('SELECT count(*)::int AS count FROM netsuite_request_queue');
      if (count.rows[0].count >= 500) { throw netSuiteQueueError('NETSUITE_QUEUE_FULL', 'NetSuite request queue is full.'); }
      const id = randomUUID();
      await client.query(`INSERT INTO netsuite_request_queue (id, priority, expires_at)
        VALUES ($1, $2, clock_timestamp() + $3 * interval '1 millisecond')`,
      [id, priority === 'operator' ? 1 : 0, WAITING_LEASE_MS]);
      return id;
    });
  },
  /** @param {string} id @param {number} timeoutMs */
  claim(id, timeoutMs) {
    return locked(async client => {
      const own = await client.query(`UPDATE netsuite_request_queue
        SET expires_at = clock_timestamp() + $2 * interval '1 millisecond'
        WHERE id = $1 AND state = 'waiting' RETURNING priority`, [id, WAITING_LEASE_MS]);
      if (!own.rowCount) { throw netSuiteQueueError('NETSUITE_QUEUE_EXPIRED', 'NetSuite queue reservation expired.'); }
      const active = await client.query(`SELECT count(*)::int AS total,
        count(*) FILTER (WHERE priority = 0)::int AS background
        FROM netsuite_request_queue WHERE state = 'running'`);
      if (active.rows[0].total >= NETSUITE_REQUEST_LIMIT) { return false; }
      const next = await client.query(`SELECT id FROM netsuite_request_queue WHERE state = 'waiting'
        AND (priority = 1 OR $1 < $2) ORDER BY priority DESC, sequence LIMIT 1`,
      [active.rows[0].background, NETSUITE_BACKGROUND_LIMIT]);
      if (next.rows[0]?.id !== id) { return false; }
      await client.query(`UPDATE netsuite_request_queue SET state = 'running',
        expires_at = clock_timestamp() + $2 * interval '1 millisecond' WHERE id = $1`,
      [id, timeoutMs + RECOVERY_GRACE_MS]);
      return true;
    });
  },
  /** @param {string} id */
  async release(id) { await queuePool.query('DELETE FROM netsuite_request_queue WHERE id = $1', [id]); }
};
