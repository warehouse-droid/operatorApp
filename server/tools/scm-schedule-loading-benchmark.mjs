#!/usr/bin/env node

import { performance } from "node:perf_hooks";

import { closeDb } from "../src/db.js";
import { listScmSchedule } from "../src/dispatch-repository.js";
import { enrichScmScheduleWithReconciliation } from "../src/scm-reconciliation-repository.js";

function positiveInteger(value, fallback, maximum) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    return fallback;
  }
  return Math.min(parsed, maximum);
}

function percentile(values, percentileValue) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(sorted.length * percentileValue) - 1)] || 0;
}

function benchmarkFilters() {
  const raw = String(process.env.SCM_SCHEDULE_BENCHMARK_FILTERS || "").trim();
  if (!raw) {
    return { view: "scm working", audience: "scm" };
  }
  const parsed = JSON.parse(raw);
  if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") {
    throw new TypeError("SCM_SCHEDULE_BENCHMARK_FILTERS must be a JSON object.");
  }
  return { ...parsed, audience: parsed.audience || "scm" };
}

const samplesRequested = positiveInteger(process.env.SCM_SCHEDULE_BENCHMARK_SAMPLES, 3, 20);
const warmups = positiveInteger(process.env.SCM_SCHEDULE_BENCHMARK_WARMUPS, 1, 5);
const limitMs = positiveInteger(process.env.SCM_SCHEDULE_BENCHMARK_LIMIT_MS, 2_000, 60_000);
const enforce = process.argv.includes("--enforce");
const filters = benchmarkFilters();

async function loadOnce() {
  const startedAt = performance.now();
  const rows = await listScmSchedule(filters);
  const listedAt = performance.now();
  const enriched = await enrichScmScheduleWithReconciliation(rows, {
    includeDetails: false,
    view: filters.view || "",
    reviewOnly: false
  });
  const finishedAt = performance.now();
  return {
    rows: enriched,
    listMs: listedAt - startedAt,
    reconciliationMs: finishedAt - listedAt,
    totalMs: finishedAt - startedAt,
    responseBytes: Buffer.byteLength(JSON.stringify(enriched), "utf8")
  };
}

try {
  for (let index = 0; index < warmups; index += 1) {
    await loadOnce();
  }
  const samples = [];
  for (let index = 0; index < samplesRequested; index += 1) {
    samples.push(await loadOnce());
  }
  const report = {
    filters,
    limitMs,
    samples: samples.map((sample) => ({
      listMs: Number(sample.listMs.toFixed(1)),
      reconciliationMs: Number(sample.reconciliationMs.toFixed(1)),
      totalMs: Number(sample.totalMs.toFixed(1)),
      rows: sample.rows.length,
      responseBytes: sample.responseBytes
    })),
    p95Ms: Number(percentile(samples.map((sample) => sample.totalMs), 0.95).toFixed(1)),
    maxMs: Number(Math.max(...samples.map((sample) => sample.totalMs)).toFixed(1))
  };
  console.log(JSON.stringify(report, null, 2));
  if (enforce && report.maxMs >= limitMs) {
    throw new Error(`PO/TO Schedule max ${report.maxMs}ms exceeded ${limitMs}ms.`);
  }
} finally {
  await closeDb();
}
