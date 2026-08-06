import { appendFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";

/**
 * Test-only latency recorder.  Benchmarks append individual samples so a
 * failing performance budget remains inspectable rather than being reduced to
 * one aggregate number.
 */
export async function recordDispatchPerformanceSamples({ scenario, samples, responseBytes = [] }) {
  const sorted = [...samples].sort((left, right) => left - right);
  const percentile = (fraction) => sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)] ?? 0;
  const entry = {
    scenario,
    recordedAt: new Date().toISOString(),
    samplesMs: samples,
    medianMs: percentile(0.5),
    p95Ms: percentile(0.95),
    maxMs: sorted.at(-1) ?? 0,
    responseBytes
  };
  const target = resolve(process.cwd(), "test-artifacts/dispatch-performance.jsonl");
  await mkdir(dirname(target), { recursive: true });
  await appendFile(target, `${JSON.stringify(entry)}\n`, "utf8");
  return entry;
}
