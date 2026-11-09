// @ts-check
// Resource monitor: every 30 s the app records host CPU and memory, its own CPU, memory and
// event-loop lag, and database activity (active queries, the longest-running query) in
// system_resource_samples, kept 14 days. Admin -> Audit Log charts the samples beside the events.
// Sustained high CPU, low memory, a blocked event loop and long-running database queries are also
// written to the Audit Log as warnings, with the query text, so a slowdown names its cause.
// (2026-11-05: three runaway In/Outbound searches held the database for 8 minutes and every page
// slowed; nothing recorded which query it was.)
import fs from 'node:fs/promises';
import os from 'node:os';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import pg from 'pg';
import { config } from './config.js';
import { pool as appDatabasePool, query } from './db.js';
import { recordSystemEvent } from './system-audit.js';

export const RESOURCE_SAMPLE_INTERVAL_MS = 30_000;
export const RESOURCE_RETENTION_DAYS = 14;
const MAX_CHART_POINTS = 360;
const DEFAULT_RANGE_MS = 6 * 3_600_000;
const MAX_RANGE_MS = RESOURCE_RETENTION_DAYS * 86_400_000;
const RETENTION_SWEEP_MS = 3_600_000;
const MB = 1024 * 1024;
const stderr = console.error.bind(console);

const round = (value, digits = 1) => (Number.isFinite(value) ? Number(value.toFixed(digits)) : null);
const clampPercent = (value) => Math.min(100, Math.max(0, value));

/** CPU counters of the host from /proc/stat ("cpu" line; guest time is already inside user/nice).
 * @param {string} text */
export function parseProcStatCpu(text) {
  const line = String(text || '').split('\n').find((row) => /^cpu\s/u.test(row));
  if (!line) return null;
  const values = line.trim().split(/\s+/u).slice(1, 9).map(Number);
  if (values.length < 4 || values.some((value) => !Number.isFinite(value))) return null;
  const [user, nice, system, idle, iowait = 0, irq = 0, softirq = 0, steal = 0] = values;
  const busy = user + nice + system + irq + softirq + steal;
  return { busy, total: busy + idle + iowait };
}

/** Busy share of the host between two /proc/stat readings, in percent.
 * @param {{busy: number, total: number} | null} previous @param {{busy: number, total: number} | null} current */
export function cpuPercentBetween(previous, current) {
  if (!previous || !current) return null;
  const total = current.total - previous.total;
  if (!(total > 0)) return null;
  return round(clampPercent(((current.busy - previous.busy) / total) * 100));
}

/** @param {string} text */
export function parseMeminfo(text) {
  const read = (key) => {
    const match = String(text || '').match(new RegExp(`^${key}:\\s+(\\d+)\\s+kB`, 'mu'));
    return match ? Number(match[1]) * 1024 : null;
  };
  const totalBytes = read('MemTotal');
  const availableBytes = read('MemAvailable');
  return totalBytes && availableBytes !== null ? { totalBytes, availableBytes } : null;
}

/** CPU time used by this container (cgroup v2), in microseconds. @param {string} text */
export function parseCgroupCpuUsec(text) {
  const match = String(text || '').match(/^usage_usec\s+(\d+)/mu);
  return match ? Number(match[1]) : null;
}

/** @param {number} seconds */
export function formatDuration(seconds) {
  const value = Math.max(0, Math.round(Number(seconds) || 0));
  if (value < 60) return `${value} s`;
  const minutes = Math.floor(value / 60);
  if (minutes < 60) return `${minutes} min ${String(value % 60).padStart(2, '0')} s`;
  return `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, '0')} min`;
}

function queryPreview(text, limit = 160) {
  const compact = String(text || '').replace(/\s+/gu, ' ').trim();
  return compact.length > limit ? `${compact.slice(0, limit - 1)}…` : compact;
}

/** Turns samples into Audit Log warnings. Pure apart from `record`, so tests can drive it.
 * @param {{record?: (event: Record<string, any>) => unknown, cpuHighPercent?: number, cpuHighSamples?: number,
 *  cpuRecoverPercent?: number, repeatMs?: number, memoryLowPercent?: number, memoryRecoverPercent?: number,
 *  eventLoopBlockedMs?: number, eventLoopRepeatMs?: number, longQuerySeconds?: number,
 *  longQueryErrorSeconds?: number, poolWaitingWarn?: number, poolRepeatMs?: number}} [options] */
export function createResourceAlerts({
  record = recordSystemEvent,
  cpuHighPercent = 85,
  cpuHighSamples = 2,
  cpuRecoverPercent = 70,
  repeatMs = 10 * 60_000,
  memoryLowPercent = 10,
  memoryRecoverPercent = 15,
  eventLoopBlockedMs = 1000,
  eventLoopRepeatMs = 5 * 60_000,
  longQuerySeconds = 60,
  longQueryErrorSeconds = 300,
  poolWaitingWarn = 5,
  poolRepeatMs = 5 * 60_000
} = {}) {
  const cpu = { streak: 0, since: 0, lastAlertAt: 0, peak: 0 };
  const memory = { since: 0, lastAlertAt: 0, lowest: 100 };
  let eventLoopLastAlertAt = 0;
  let poolLastAlertAt = 0;
  /** @type {Map<string, string>} query key -> severity already reported */
  const reportedQueries = new Map();
  const emit = (event) => record({ category: 'system', source: 'resource-monitor', ...event });

  function context(sample) {
    const longest = sample.longQueries?.[0];
    const parts = [`App ${sample.appCpuPercent ?? '?'}%`, `DB ${sample.dbActiveQueries ?? '?'} active queries`];
    if (longest && longest.seconds >= 10) parts.push(`longest query ${formatDuration(longest.seconds)}: ${queryPreview(longest.query, 120)}`);
    return parts.join('; ');
  }

  /** @param {Record<string, any>} sample @param {number} [now] */
  function observe(sample, now = Date.now()) {
    const details = {
      hostCpuPercent: sample.hostCpuPercent, appCpuPercent: sample.appCpuPercent,
      hostMemoryAvailablePercent: sample.hostMemoryAvailablePercent, dbActiveQueries: sample.dbActiveQueries,
      dbConnections: sample.dbConnections, longestQuery: sample.longQueries?.[0] || null
    };

    const hostCpu = sample.hostCpuPercent;
    if (Number.isFinite(hostCpu)) {
      cpu.streak = hostCpu >= cpuHighPercent ? cpu.streak + 1 : 0;
      if (cpu.since) cpu.peak = Math.max(cpu.peak, hostCpu);
      if (!cpu.since && cpu.streak >= cpuHighSamples) {
        cpu.since = now - (cpu.streak - 1) * (sample.intervalMs || RESOURCE_SAMPLE_INTERVAL_MS);
        cpu.lastAlertAt = now;
        cpu.peak = hostCpu;
        emit({ severity: 'warning', action: 'system.resource.cpu_high', durationMs: now - cpu.since,
          message: `Host CPU ${hostCpu}% (at least ${cpuHighPercent}% for ${formatDuration((now - cpu.since) / 1000)}). ${context(sample)}`,
          details });
      } else if (cpu.since && hostCpu >= cpuRecoverPercent && now - cpu.lastAlertAt >= repeatMs) {
        cpu.lastAlertAt = now;
        emit({ severity: 'warning', action: 'system.resource.cpu_high', durationMs: now - cpu.since,
          message: `Host CPU still high: ${hostCpu}% after ${formatDuration((now - cpu.since) / 1000)} (peak ${cpu.peak}%). ${context(sample)}`,
          details });
      } else if (cpu.since && hostCpu < cpuRecoverPercent) {
        emit({ severity: 'info', action: 'system.resource.cpu_recovered', durationMs: now - cpu.since,
          message: `Host CPU back to ${hostCpu}% after ${formatDuration((now - cpu.since) / 1000)} high (peak ${cpu.peak}%).`,
          details });
        cpu.since = 0;
        cpu.peak = 0;
      }
    }

    const available = sample.hostMemoryAvailablePercent;
    if (Number.isFinite(available)) {
      if (memory.since) memory.lowest = Math.min(memory.lowest, available);
      if (available < memoryLowPercent && (!memory.since || now - memory.lastAlertAt >= repeatMs)) {
        if (!memory.since) {
          memory.since = now;
          memory.lowest = available;
        }
        memory.lastAlertAt = now;
        emit({ severity: 'warning', action: 'system.resource.memory_low',
          message: `Host memory low: ${available}% available (${sample.hostMemoryAvailableMb} MB). App uses ${sample.appMemoryMb} MB.`,
          details: { ...details, hostMemoryAvailableMb: sample.hostMemoryAvailableMb, appMemoryMb: sample.appMemoryMb } });
      } else if (memory.since && available >= memoryRecoverPercent) {
        emit({ severity: 'info', action: 'system.resource.memory_recovered', durationMs: now - memory.since,
          message: `Host memory back to ${available}% available after ${formatDuration((now - memory.since) / 1000)} (lowest ${memory.lowest}%).`,
          details });
        memory.since = 0;
        memory.lowest = 100;
      }
    }

    const blockedMs = sample.eventLoopMaxMs;
    if (Number.isFinite(blockedMs) && blockedMs >= eventLoopBlockedMs && now - eventLoopLastAlertAt >= eventLoopRepeatMs) {
      eventLoopLastAlertAt = now;
      emit({ severity: 'warning', action: 'system.resource.event_loop_blocked', durationMs: Math.round(blockedMs),
        message: `App event loop blocked for ${(blockedMs / 1000).toFixed(1)} s; every request waited. ${context(sample)}`,
        details: { ...details, eventLoopMaxMs: blockedMs, eventLoopP99Ms: sample.eventLoopP99Ms } });
    }

    // Requests queued for one of the app's database connections: every page waits behind them (2026-11-06).
    const appPool = sample.appPool;
    if (appPool && Number.isFinite(appPool.waitingMax) && appPool.waitingMax >= poolWaitingWarn && now - poolLastAlertAt >= poolRepeatMs) {
      poolLastAlertAt = now;
      emit({ severity: 'warning', action: 'system.db.pool_exhausted',
        message: `All ${appPool.max ?? '?'} app database connections were busy; up to ${appPool.waitingMax} requests waited for one. ${context(sample)}`,
        details: { ...details, appPool } });
    }

    const seen = new Set();
    for (const longQuery of sample.longQueries || []) {
      const key = `${longQuery.pid}:${longQuery.queryStart}`;
      seen.add(key);
      const severity = longQuery.seconds >= longQueryErrorSeconds ? 'error' : longQuery.seconds >= longQuerySeconds ? 'warning' : '';
      if (!severity || reportedQueries.get(key) === severity || reportedQueries.get(key) === 'error') continue;
      reportedQueries.set(key, severity);
      const workers = longQuery.parallelWorkers ? `, ${longQuery.parallelWorkers} parallel workers` : '';
      emit({ severity, action: 'system.db.long_query', durationMs: longQuery.seconds * 1000,
        message: `${severity === 'error' ? 'Database query still running' : 'Database query running'} for ${formatDuration(longQuery.seconds)} (pid ${longQuery.pid}${workers}): ${queryPreview(longQuery.query)}`,
        details: { ...details, longestQuery: undefined, query: longQuery } });
    }
    for (const key of reportedQueries.keys()) if (!seen.has(key)) reportedQueries.delete(key);
  }

  return { observe };
}

const LONG_QUERY_SQL = `
  SELECT a.pid,
         a.query_start,
         GREATEST(0, EXTRACT(EPOCH FROM (clock_timestamp() - a.query_start)))::int AS seconds,
         a.wait_event_type,
         a.wait_event,
         COALESCE(a.application_name, '') AS application_name,
         host(a.client_addr) AS client_addr,
         LEFT(regexp_replace(a.query, '\\s+', ' ', 'g'), 1000) AS query,
         (SELECT count(*)::int FROM pg_stat_activity worker WHERE worker.leader_pid = a.pid AND worker.pid <> a.pid) AS parallel_workers
    FROM pg_stat_activity a
   WHERE a.datname = current_database()
     AND a.pid <> pg_backend_pid()
     AND a.backend_type = 'client backend'
     AND a.state = 'active'
     AND a.query_start IS NOT NULL
     AND COALESCE(a.application_name, '') NOT IN ('pg_dump', 'pg_basebackup', 'pg_restore')
   ORDER BY a.query_start
   LIMIT 5`;

const ACTIVITY_SQL = `
  SELECT count(*) FILTER (WHERE backend_type = 'client backend')::int AS connections,
         count(*) FILTER (WHERE backend_type = 'client backend' AND state = 'active')::int AS active,
         count(*) FILTER (WHERE backend_type = 'client backend' AND wait_event_type = 'Lock')::int AS waiting,
         count(*) FILTER (WHERE backend_type = 'parallel worker')::int AS parallel_workers
    FROM pg_stat_activity
   WHERE datname = current_database()
     AND pid <> pg_backend_pid()`;

const INSERT_SQL = `
  INSERT INTO system_resource_samples (
    sampled_at, process_name, interval_ms, host_cpu_percent, host_cpu_cores, host_load_1m,
    host_memory_total_mb, host_memory_available_mb, app_cpu_percent, app_memory_mb, app_heap_mb,
    event_loop_max_ms, event_loop_p99_ms, db_connections, db_active_queries, db_waiting_queries,
    db_parallel_workers, db_longest_query_seconds, details
  ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19::jsonb)`;

/** Starts sampling in this process. Returns {sampleNow, stop}; sampleNow resolves to the stored sample.
 * @param {{processName?: string, intervalMs?: number, enabled?: boolean, alerts?: ReturnType<typeof createResourceAlerts>,
 *  readFile?: (path: string) => Promise<string>, pool?: {query: Function, end?: Function}, now?: () => number,
 *  appPool?: {waitingCount?: number, totalCount?: number, idleCount?: number, options?: {max?: number}}|null, poolProbeMs?: number}} [options] */
export function startSystemResourceMonitor({
  processName = 'app',
  intervalMs = Number(process.env.SYSTEM_RESOURCE_SAMPLE_MS) || RESOURCE_SAMPLE_INTERVAL_MS,
  enabled = process.env.SYSTEM_RESOURCE_MONITOR !== 'off',
  alerts = createResourceAlerts(),
  readFile = (path) => fs.readFile(path, 'utf8'),
  pool = null,
  now = Date.now,
  appPool = appDatabasePool,
  poolProbeMs = 1000
} = {}) {
  if (!enabled) return { sampleNow: async () => null, stop: async () => {} };
  const ownPool = !pool;
  const db = pool || new pg.Pool({
    connectionString: config.databaseUrl,
    max: 1,
    connectionTimeoutMillis: 3000,
    idleTimeoutMillis: 60_000,
    statement_timeout: 5000,
    allowExitOnIdle: true,
    application_name: 'mbbs-resource-monitor'
  });
  if (ownPool) db.on?.('error', (error) => reportFailure('database connection failed', error));
  const eventLoop = monitorEventLoopDelay({ resolution: 20 });
  eventLoop.enable();
  const cores = os.availableParallelism?.() || os.cpus().length || 1;
  let previous = null;
  let running = null;
  let lastSweepAt = 0;
  let lastFailureAt = 0;
  // Peak number of requests queued for one of this process's database connections since the last
  // sample, probed every second so a short exhaustion between two samples is still recorded.
  let poolWaitingMax = 0;
  const probePool = () => { poolWaitingMax = Math.max(poolWaitingMax, Number(appPool?.waitingCount) || 0); };
  const poolTimer = appPool ? setInterval(probePool, poolProbeMs) : null;
  poolTimer?.unref?.();

  function reportFailure(label, error) {
    // stderr only: console.error is captured into the audit log and would echo every failed sample.
    if (Date.now() - lastFailureAt < 10 * 60_000) return;
    lastFailureAt = Date.now();
    try { stderr(`[resource-monitor] ${label}:`, error instanceof Error ? error.message : String(error)); } catch { /* ignore */ }
  }

  async function readCounters() {
    const read = (path) => readFile(path).catch(() => '');
    const [stat, cgroupCpu] = await Promise.all([read('/proc/stat'), read('/sys/fs/cgroup/cpu.stat')]);
    const cgroupUsec = parseCgroupCpuUsec(cgroupCpu);
    const processCpu = process.cpuUsage();
    return { at: now(), hostCpu: parseProcStatCpu(stat), appUsec: cgroupUsec ?? processCpu.user + processCpu.system };
  }

  async function databaseActivity() {
    try {
      const [activity, longQueries] = await Promise.all([db.query(ACTIVITY_SQL), db.query(LONG_QUERY_SQL)]);
      return {
        ...activity.rows[0],
        longQueries: longQueries.rows.map((row) => ({
          pid: row.pid, queryStart: new Date(row.query_start).toISOString(), seconds: row.seconds,
          waitEvent: [row.wait_event_type, row.wait_event].filter(Boolean).join(':') || null,
          applicationName: row.application_name || null, clientAddr: row.client_addr || null,
          parallelWorkers: row.parallel_workers, query: row.query
        }))
      };
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error), longQueries: [] };
    }
  }

  async function takeSample() {
    const current = await readCounters();
    const [meminfo, loadavg, db] = await Promise.all([
      readFile('/proc/meminfo').catch(() => ''), readFile('/proc/loadavg').catch(() => ''), databaseActivity()
    ]);
    const memory = parseMeminfo(meminfo) || { totalBytes: os.totalmem(), availableBytes: os.freemem() };
    const elapsedUsec = previous ? (current.at - previous.at) * 1000 : 0;
    const usage = process.memoryUsage();
    const longest = db.longQueries[0] || null;
    probePool();
    const appPoolUse = appPool ? { max: appPool.options?.max ?? null, total: appPool.totalCount ?? null, idle: appPool.idleCount ?? null,
      waitingNow: Number(appPool.waitingCount) || 0, waitingMax: poolWaitingMax } : null;
    poolWaitingMax = 0;
    const sample = {
      sampledAt: new Date(current.at).toISOString(),
      processName,
      intervalMs,
      hostCpuPercent: cpuPercentBetween(previous?.hostCpu ?? null, current.hostCpu),
      hostCpuCores: cores,
      hostLoad1m: round(Number.parseFloat(String(loadavg)), 2) ?? round(os.loadavg()[0], 2),
      hostMemoryTotalMb: Math.round(memory.totalBytes / MB),
      hostMemoryAvailableMb: Math.round(memory.availableBytes / MB),
      hostMemoryAvailablePercent: round((memory.availableBytes / memory.totalBytes) * 100),
      appCpuPercent: previous && elapsedUsec > 0
        ? round(clampPercent(((current.appUsec - previous.appUsec) / (elapsedUsec * cores)) * 100)) : null,
      appMemoryMb: Math.round(usage.rss / MB),
      appHeapMb: Math.round(usage.heapUsed / MB),
      eventLoopMaxMs: round(eventLoop.max / 1e6),
      eventLoopP99Ms: round(eventLoop.percentile(99) / 1e6),
      dbConnections: db.connections ?? null,
      dbActiveQueries: db.active ?? null,
      dbWaitingQueries: db.waiting ?? null,
      dbParallelWorkers: db.parallel_workers ?? null,
      dbLongestQuerySeconds: longest ? longest.seconds : (db.error ? null : 0),
      longQueries: db.longQueries,
      dbError: db.error || null,
      appPool: appPoolUse
    };
    eventLoop.reset();
    previous = current;
    return sample;
  }

  async function store(sample) {
    const longest = sample.longQueries[0];
    const details = {
      ...(longest && longest.seconds >= 5 ? { longestQuery: { ...longest, query: queryPreview(longest.query, 300) } } : {}),
      ...(sample.dbError ? { dbError: sample.dbError } : {}),
      ...(sample.appPool ? { appPool: sample.appPool } : {})
    };
    await db.query(INSERT_SQL, [
      sample.sampledAt, sample.processName, sample.intervalMs, sample.hostCpuPercent, sample.hostCpuCores, sample.hostLoad1m,
      sample.hostMemoryTotalMb, sample.hostMemoryAvailableMb, sample.appCpuPercent, sample.appMemoryMb, sample.appHeapMb,
      sample.eventLoopMaxMs, sample.eventLoopP99Ms, sample.dbConnections, sample.dbActiveQueries, sample.dbWaitingQueries,
      sample.dbParallelWorkers, sample.dbLongestQuerySeconds, JSON.stringify(details)
    ]);
    if (now() - lastSweepAt >= RETENTION_SWEEP_MS) {
      lastSweepAt = now();
      await db.query(`DELETE FROM system_resource_samples WHERE sampled_at < now() - make_interval(days => ${RESOURCE_RETENTION_DAYS})`);
    }
  }

  async function sampleNow() {
    if (running) return running;
    running = (async () => {
      try {
        const sample = await takeSample();
        try { alerts.observe(sample, now()); } catch (error) { reportFailure('alert check failed', error); }
        await store(sample);
        return sample;
      } catch (error) {
        reportFailure('sample failed', error);
        return null;
      } finally {
        running = null;
      }
    })();
    return running;
  }

  // The first reading is only a baseline for CPU deltas.
  void readCounters().then((counters) => { previous ||= counters; }).catch(() => null);
  const timer = setInterval(() => void sampleNow(), intervalMs);
  timer.unref?.();
  return {
    sampleNow,
    async stop() {
      clearInterval(timer);
      if (poolTimer) clearInterval(poolTimer);
      eventLoop.disable();
      if (running) await running;
      if (ownPool) await db.end();
    }
  };
}

/** Samples between from and to (default: the last 6 hours), at most 360 points; each point is the
 * peak of its time bucket so short spikes stay visible.
 * @param {{from?: string, to?: string}} [range] */
export async function listSystemResourceSamples({ from = '', to = '' } = {}) {
  const parse = (value) => {
    const time = Date.parse(String(value || ''));
    return Number.isFinite(time) ? time : null;
  };
  const nowMs = Date.now();
  let toMs = parse(to);
  let fromMs = parse(from);
  if (toMs === null) toMs = nowMs;
  if (fromMs === null || fromMs >= toMs) fromMs = toMs - DEFAULT_RANGE_MS;
  if (toMs - fromMs > MAX_RANGE_MS) fromMs = toMs - MAX_RANGE_MS;
  const intervalSeconds = RESOURCE_SAMPLE_INTERVAL_MS / 1000;
  const bucketSeconds = Math.max(intervalSeconds,
    Math.ceil((toMs - fromMs) / 1000 / MAX_CHART_POINTS / intervalSeconds) * intervalSeconds);
  const result = await query(
    `SELECT date_bin(make_interval(secs => $3::int), sampled_at, TIMESTAMPTZ '2000-01-01') AS bucket_at,
            count(*)::int AS samples,
            max(host_cpu_percent) AS host_cpu_percent,
            max(app_cpu_percent) AS app_cpu_percent,
            max(100 - 100.0 * host_memory_available_mb / NULLIF(host_memory_total_mb, 0))::real AS host_memory_used_percent,
            min(host_memory_available_mb) AS host_memory_available_mb,
            max(host_memory_total_mb) AS host_memory_total_mb,
            max(host_cpu_cores) AS host_cpu_cores,
            max(host_load_1m) AS host_load_1m,
            max(app_memory_mb) AS app_memory_mb,
            max(app_heap_mb) AS app_heap_mb,
            max(event_loop_max_ms) AS event_loop_max_ms,
            max(db_connections) AS db_connections,
            max(db_active_queries) AS db_active_queries,
            max(db_waiting_queries) AS db_waiting_queries,
            max(db_longest_query_seconds) AS db_longest_query_seconds,
            (ARRAY_AGG(details->'longestQuery' ORDER BY db_longest_query_seconds DESC NULLS LAST)
              FILTER (WHERE details ? 'longestQuery'))[1] AS longest_query
       FROM system_resource_samples
      WHERE sampled_at >= $1::timestamptz
        AND sampled_at < $2::timestamptz
      GROUP BY 1
      ORDER BY 1`,
    [new Date(fromMs).toISOString(), new Date(toMs).toISOString(), bucketSeconds]
  );
  const first = await query('SELECT min(sampled_at) AS first_sampled_at FROM system_resource_samples');
  const number = (value) => (value === null || value === undefined ? null : round(Number(value)));
  return {
    from: new Date(fromMs).toISOString(),
    to: new Date(toMs).toISOString(),
    intervalSeconds,
    bucketSeconds,
    firstSampledAt: first.rows[0]?.first_sampled_at ? new Date(first.rows[0].first_sampled_at).toISOString() : null,
    samples: result.rows.map((row) => ({
      at: new Date(row.bucket_at).toISOString(),
      samples: row.samples,
      hostCpuPercent: number(row.host_cpu_percent),
      appCpuPercent: number(row.app_cpu_percent),
      hostMemoryUsedPercent: number(row.host_memory_used_percent),
      hostMemoryAvailableMb: row.host_memory_available_mb,
      hostMemoryTotalMb: row.host_memory_total_mb,
      hostCpuCores: row.host_cpu_cores,
      hostLoad1m: number(row.host_load_1m),
      appMemoryMb: row.app_memory_mb,
      appHeapMb: row.app_heap_mb,
      eventLoopMaxMs: number(row.event_loop_max_ms),
      dbConnections: row.db_connections,
      dbActiveQueries: row.db_active_queries,
      dbWaitingQueries: row.db_waiting_queries,
      dbLongestQuerySeconds: row.db_longest_query_seconds,
      longestQuery: row.longest_query || null
    }))
  };
}
