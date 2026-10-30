// Compare two dispatch-history-replay-all.mjs result files state by state.
// Exit 1 when a state the baseline accepted is rejected or loses cargo.
import { readFile, writeFile } from "node:fs/promises";

const [baselinePath, candidatePath, outputPath] = process.argv.slice(2);
const load = async (path) => new Map((await readFile(path, "utf8")).split("\n").filter(Boolean)
  .map((line) => JSON.parse(line)).map((row) => [`${row.stream}:${row.sourceId}`, row]));
const baseline = await load(baselinePath);
const candidate = await load(candidatePath);
const accepted = (row) => row?.result === "saved";
const brief = (row) => row && { result: row.result, code: row.code, message: row.message, route: row.route,
  delivery: row.delivery };
const report = { regressions: [], fixed: [], routeChanged: [], deliveryChanged: [], missing: [], otherChanges: [] };
for (const [key, before] of baseline) {
  const after = candidate.get(key);
  const entry = { key, planId: before.planId, planDate: before.planDate, baseline: brief(before), candidate: brief(after) };
  if (!after) report.missing.push(entry);
  else if (accepted(before) && !accepted(after)) report.regressions.push(entry);
  else if (!accepted(before) && accepted(after)) report.fixed.push(entry);
  else if (accepted(before) && before.route !== after.route) report.routeChanged.push(entry);
  else if (before.result !== after.result || before.code !== after.code) report.otherChanges.push(entry);
  if (after && JSON.stringify(before.delivery || null) !== JSON.stringify(after.delivery || null)) {
    report.deliveryChanged.push(entry);
  }
}
// A delivery difference is explained when every differing split travels inside a
// group in that plan state (the grouped-split materialization fix).
report.deliveryUnexplained = [];
let explainedChanges = 0;
for (const entry of report.deliveryChanged) {
  const before = new Set(entry.baseline.delivery?.changed || []);
  const after = new Set(entry.candidate?.delivery?.changed || []);
  const grouped = new Set(candidate.get(entry.key)?.groupedSplits || []);
  const differing = [...before, ...after].filter((change) => !(before.has(change) && after.has(change)));
  const unexplained = differing.filter((change) => !grouped.has(change.split(":")[0]));
  if (entry.baseline.delivery?.result !== entry.candidate?.delivery?.result || unexplained.length) {
    report.deliveryUnexplained.push({ ...entry, unexplained });
  } else explainedChanges += differing.length;
}
report.explainedDeliveryChanges = explainedChanges;
const summary = Object.fromEntries(Object.entries(report).map(([name, rows]) => [name, Array.isArray(rows) ? rows.length : rows]));
await writeFile(outputPath, `${JSON.stringify({ summary, ...report }, null, 2)}\n`, { mode: 0o600 });
console.log(JSON.stringify({ summary }));
for (const name of ["regressions", "deliveryUnexplained", "fixed", "routeChanged", "otherChanges", "missing"]) {
  for (const row of report[name].slice(0, 40)) console.log(JSON.stringify({ kind: name, ...row }));
}
if (report.regressions.length || report.missing.length || report.deliveryUnexplained.length) process.exitCode = 1;
