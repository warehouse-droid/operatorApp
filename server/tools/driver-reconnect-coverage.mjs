import fs from "node:fs";
import crypto from "node:crypto";

const root = "test-artifacts";
const hashes = JSON.parse(fs.readFileSync(`${root}/final/runtime-hashes.json`));
const sources = Object.fromEntries(Object.keys(hashes).filter(file => file.endsWith(".js")).map(file => [file, fs.readFileSync(file, "utf8")]));
const scripts = new Map();
function add(file, functions, origin, offset = 0) {
  if (!sources[file]) return;
  if (!scripts.has(file)) scripts.set(file, []);
  scripts.get(file).push({origin, ranges: functions.flatMap(fn => fn.ranges).map(range => ({...range,
    startOffset: range.startOffset + offset, endOffset: range.endOffset + offset}))});
}
const browserPhase = process.env.RECOVERY_COVERAGE_PHASE || "browser-complete";
for (const [dir, origin] of [[`${root}/final/raw`, "unit"], [`${root}/${browserPhase}/results/server-coverage`, "server/integration"]]) {
  if (!fs.existsSync(dir)) continue;
  for (const name of fs.readdirSync(dir).filter(name => name.endsWith(".json"))) {
    for (const entry of JSON.parse(fs.readFileSync(`${dir}/${name}`)).result || []) {
      const file = entry.url.replace(/^file:\/\//u, "").replace(/^\/app\//u, "");
      add(file, entry.functions, origin);
    }
  }
}
for (const name of fs.readdirSync(`${root}/${browserPhase}/results`, {recursive: true}).filter(name => name.endsWith("driver-coverage.json"))) {
  for (const entry of JSON.parse(fs.readFileSync(`${root}/${browserPhase}/results/${name}`))) {
    const file = "public/" + new URL(entry.url).pathname.slice(1);
    if (!sources[file]) continue;
    if (crypto.createHash("sha256").update(entry.source).digest("hex") !== hashes[file]) throw new Error(`Stale browser source: ${file}`);
    add(file, entry.functions, "browser");
  }
}
const added = new Map();
let file;
let line;
for (const row of fs.readFileSync(`${root}/runtime.patch`, "utf8").split("\n")) {
  if (row.startsWith("+++ b/")) {file = row.slice(6); added.set(file, []); continue;}
  const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)/u.exec(row);
  if (hunk) {line = Number(hunk[1]); continue;}
  if (row.startsWith("+") && !row.startsWith("+++")) {added.get(file).push(line); line++;}
  else if (row.startsWith(" ")) line++;
}
const coverage = [];
for (const [file, lines] of added) {
  if (!sources[file] || file.endsWith("driver-service-worker.js")) continue;
  const rows = sources[file].split("\n");
  const starts = [0];
  for (const row of rows) starts.push(starts.at(-1) + row.length + 1);
  for (const line of lines) {
    const text = rows[line - 1];
    if (!text.trim() || /^[\s{});,]*$/u.test(text) || /^\s*(?:\/\/|\/\*|\*)/u.test(text)) continue;
    const offset = starts[line - 1] + text.search(/\S/u);
    const origins = [];
    for (const script of scripts.get(file) || []) {
      const ranges = script.ranges.filter(range => range.startOffset <= offset && offset < range.endOffset)
        .sort((a, b) => a.endOffset - a.startOffset - (b.endOffset - b.startOffset));
      if (ranges[0]?.count > 0) origins.push(script.origin);
    }
    coverage.push({file, line, covered: origins.length > 0, origins: [...new Set(origins)]});
  }
}
const missed = coverage.filter(row => !row.covered);
fs.writeFileSync(`${root}/final/changed-line-coverage.json`, JSON.stringify(coverage, null, 2) + "\n");
console.log(JSON.stringify({changedLines: coverage.length, covered: coverage.length - missed.length, missed}));
if (missed.length) process.exitCode = 1;
