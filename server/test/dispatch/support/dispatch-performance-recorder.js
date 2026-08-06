// @ts-check

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const ARTIFACT = path.resolve("test-artifacts/dispatch-performance.json");

/** @param {number[]} samples */
export function percentile95(samples) {
  const ordered = [...samples].sort((left, right) => left - right);
  if (!ordered.length) {return 0;}
  return ordered[Math.min(ordered.length - 1, Math.ceil(ordered.length * 0.95) - 1)];
}

/** @param {{name: string, durationMs: number, responseBytes: number}[]} samples */
export function summarizeDispatchPerformance(samples) {
  const durations = samples.map(({ durationMs }) => durationMs);
  const bytes = samples.map(({ responseBytes }) => responseBytes);
  return {
    samples,
    medianMs: [...durations].sort((left, right) => left - right)[Math.floor(durations.length / 2)] || 0,
    p95Ms: percentile95(durations),
    maxMs: Math.max(0, ...durations),
    maxResponseBytes: Math.max(0, ...bytes)
  };
}

/**
 * Test artifacts are deliberately ignored by git. This makes the timing evidence
 * inspectable after an isolated run without checking volatile measurements in.
 *
 * @param {{name: string, durationMs: number, responseBytes: number}[]} samples
 */
export async function recordDispatchPerformance(samples) {
  await mkdir(path.dirname(ARTIFACT), { recursive: true });
  let existing = { runs: [] };
  try {
    existing = JSON.parse(await readFile(ARTIFACT, "utf8"));
  } catch {
    // First test in an isolated run owns the artifact.
  }
  existing.runs = Array.isArray(existing.runs) ? existing.runs : [];
  existing.runs.push({ recordedAt: new Date().toISOString(), ...summarizeDispatchPerformance(samples) });
  await writeFile(ARTIFACT, `${JSON.stringify(existing, null, 2)}\n`, "utf8");
  return ARTIFACT;
}
