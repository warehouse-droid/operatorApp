import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

assert.equal(process.env.MBT_TEST_ISOLATED, "1");
const directory = "test-artifacts/operator-receiving-identity";
const sourcePath = "src/operator-yard-authorization.js";
const testPath = "test/mbt/integration/operator-receiving-identity.test.js";
const allocationTest = "test/mbt/integration/operator-receiving-allocations.test.js";
const uiTest = "test/mbt/unit/operator-receiving-quantity-ui.test.js";
const baselineBlocks = JSON.parse(readFileSync("test/operator-receiving-identity-baseline-blocks.json", "utf8"));
const runtimeFiles = baselineBlocks.map(block => block.file);
const hash = contents => createHash("sha256").update(contents).digest("hex");
const currentSources = Object.fromEntries(runtimeFiles.map(file => [file, readFileSync(file, "utf8")]));
const baselineSources = {};
for (const block of baselineBlocks) {
  let contents = currentSources[block.file];
  assert.equal(hash(contents), block.afterSha256, `${block.file}: update the source manifest after runtime edits`);
  for (const group of block.groups) {
    assert.equal(contents.split(group.after).length, 2, block.file);
    contents = contents.replace(group.after, group.before);
  }
  assert.equal(hash(contents), block.beforeSha256, block.file);
  baselineSources[block.file] = contents;
}
const source = readFileSync(sourcePath, "utf8");
const start = source.indexOf('    const local = orderType === "co_order"');
const end = source.indexOf("  } else {", start);
assert.ok(start > 0 && end > start);
const currentBlock = source.slice(start, end);
const oldBlock = '    const local = orderType === "co_order" || String(id).startsWith("CO-") || Number(id) < 0;\n'
  + '    order = local ? await getLocalCoReceivingOrder(id) : await getReceivingOrder(id, { includeNetSuiteClosed: true });\n';
assert.equal(source.replace(currentBlock, oldBlock), baselineSources[sourcePath]);
mkdirSync(directory, { recursive: true });
rmSync(`${directory}/coverage`, { recursive: true, force: true });
rmSync(`${directory}/c8`, { recursive: true, force: true });
const results = [];

function run(name, command, args, { accept = null, cwd = process.cwd() } = {}) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", maxBuffer: 45e6 });
  if (result.error) { throw result.error; }
  const output = `${result.stdout}${result.stderr}`;
  writeFileSync(`${directory}/${name}.log`, output);
  const accepted = accept ? accept(result, output) : result.status === 0;
  results.push({ name, exitCode: result.status, accepted });
  writeFileSync(`${directory}/gauntlet.json`, JSON.stringify(results, null, 2));
  console.log(JSON.stringify(results.at(-1)));
  assert.ok(accepted, `${name} failed; see ${directory}/${name}.log`);
  return output;
}

function sourceCopy(replacements) {
  const root = mkdtempSync(path.join(tmpdir(), "receiving-identity-"));
  for (const folder of ["src", "public", "test", "tools"]) {
    cpSync(folder, path.join(root, folder), { recursive: true });
  }
  for (const file of ["package.json", "tsconfig.mbt.json", "eslint.mbt.config.js"]) {
    cpSync(file, path.join(root, file));
  }
  symlinkSync(path.resolve("node_modules"), path.join(root, "node_modules"), "dir");
  for (const [file, contents] of Object.entries(replacements)) { writeFileSync(path.join(root, file), contents); }
  return root;
}

const files = [...runtimeFiles, testPath, allocationTest, uiTest,
  "test/mbt/unit/operator-yard-assets.test.js", "test/mbt/unit/operations-navigation-enhancements.test.js",
  "test/mbt/unit/operator-page-confirm-ui.contract.test.js", "test/mbt/unit/operator-customer-pickup-photo-gate-ui.contract.test.js",
  "tools/operator-receiving-identity-test.sh", "tools/operator-receiving-identity-reversed.mjs",
  "test/operator-receiving-identity-focused-tests.json", "tools/operator-receiving-split-search-audit.mjs",
  "tools/operator-receiving-split-search-audit.sh", "test/operator-receiving-identity-baseline-blocks.json",
  "tools/operator-receiving-identity-eslint.config.mjs", "tools/operator-receiving-identity-gauntlet.mjs",
  "tools/operator-receiving-identity-browser.mjs", "tools/operator-receiving-identity-gauntlet.sh"];
writeFileSync(`${directory}/sources.json`, JSON.stringify({
  node: process.version,
  files: Object.fromEntries(files.map(file => [file, createHash("sha256").update(readFileSync(file)).digest("hex")]))
}, null, 2));

// Run the full suite before focused tests can leave fixtures in the database
// from which the full runner creates its isolated per-file templates.
if (!process.argv.includes("--focused") && !process.argv.includes("--static")) {
  run("full", "npm", ["test"], { accept: (result, output) => {
    const existing = JSON.parse(readFileSync("test/operator-receiving-identity-baseline.json", "utf8")).full.failures;
    const failures = [...new Set([...output.matchAll(/^✖ (.+?) \([\d.]+ms\)/gm)].map(match => match[1]))];
    return (result.status === 0 || failures.length > 0) && failures.every(name => existing.includes(name));
  } });
}

const tests = JSON.parse(readFileSync("test/operator-receiving-identity-focused-tests.json", "utf8"));
if (!process.argv.includes("--static")) {
run("focused", process.execPath, ["--test", "--test-concurrency=1", ...tests]);
run("coverage", "node_modules/.bin/c8", ["--all=false", "--check-coverage=false",
  ...runtimeFiles.filter(file => file.endsWith(".js")).map(file => `--include=${file}`),
  `--temp-directory=${directory}/c8`, `--report-dir=${directory}/coverage`,
  "--reporter=json", "--reporter=json-summary", "--reporter=text",
  process.execPath, "--test", "--test-concurrency=1", testPath, allocationTest, uiTest,
  "test/mbt/unit/operator-yard-assets.test.js", "test/mbt/unit/operator-netsuite-posting-targets.red.test.js"]);
const coverageFiles = Object.values(JSON.parse(readFileSync(`${directory}/coverage/coverage-final.json`, "utf8")));
const counts = baselineBlocks.filter(block => block.file.endsWith(".js")).flatMap(block => {
  const coverage = coverageFiles.find(file => file.path.endsWith(`/${block.file}`));
  assert.ok(coverage, block.file);
  return block.changedLines.map(line => ({ file: block.file, line, count: Math.max(0,
    ...Object.entries(coverage.statementMap).filter(([, range]) => range.start.line <= line && range.end.line >= line)
      .map(([key]) => coverage.s[key])) }));
});
assert.ok(counts.every(row => row.count > 0), JSON.stringify(counts));
writeFileSync(`${directory}/changed-coverage.json`, JSON.stringify({ covered: counts.length, total: counts.length, counts }, null, 2));

const mutants = [
  ["negative means CO", 'const local = orderType === "co_order" || String(id).startsWith("CO-");',
    'const local = orderType === "co_order" || String(id).startsWith("CO-") || Number(id) < 0;', true],
  ["remove legacy fallback", "if (!order && !local && Number(id) < 0)", "if (false)", true],
  ["ignore explicit CO type", 'const local = orderType === "co_order" || String(id).startsWith("CO-");',
    'const local = String(id).startsWith("CO-");', true],
  ["skip receiving yard check", "  assertOperatorYard(operator, receiving ?", "  if (!receiving) assertOperatorYard(operator, receiving ?", true],
  ["hide closed receiving records", "await getReceivingOrder(id, { includeNetSuiteClosed: true })",
    "await getReceivingOrder(id, { includeNetSuiteClosed: false })", false]
];
const mutationResults = [];
for (const [index, [name, before, after, properties]] of mutants.entries()) {
  assert.equal(source.split(before).length, 2, name);
  const root = sourceCopy({ [sourcePath]: source.replace(before, after) });
  try {
    for (const layer of properties ? ["focused", "properties"] : ["focused"]) {
      const args = ["--test", ...(layer === "properties" ? ["--test-name-pattern=property: stored identity"] : []), testPath];
      run(`mutant-${index + 1}-${layer}`, process.execPath, args, { cwd: root,
        accept: (result, output) => result.status !== 0 && (/ERR_ASSERTION|Property failed after/.test(output)
          || (name === "hide closed receiving records" && /not ok \d+ - unknown IDs remain not found and closed orders retain the existing guard behavior[\s\S]*?error: 'Operator record not found\.'/.test(output))) });
      mutationResults.push({ name, layer, killed: true });
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
}
const receivingPath = "src/receiving-repository.js";
const targetPath = "src/operator-netsuite-posting-targets.js";
const quantityMutants = [
  ...["pallet", "layer", "section", "piece"].map(unit => [receivingPath, `subtract ${unit} allocation`,
    `${unit}_qty: remaining.${unit}_qty,`, `${unit}_qty: Math.max(remaining.${unit}_qty - line.so_allocated_${unit}_qty, 0),`, allocationTest, true]),
  [receivingPath, "subtract sales allocation", "quantity: remaining.quantity\n", "quantity: Math.max(remaining.quantity - allocatedSalesQty, 0)\n", allocationTest, true],
  [receivingPath, "ignore prior receipt", "const baselineReceived = netsuiteReceivedBaseline(line);", "const baselineReceived = 0;", allocationTest, true],
  [targetPath, "PO uses SO split ledger", "SELECT source_po_id AS source_id, source_po_ref AS source_ref\n             FROM dispatch_scm_po_splits\n            WHERE split_po_id = $1",
    "SELECT source_so_id AS source_id, source_so_ref AS source_ref\n             FROM dispatch_scm_so_splits\n            WHERE split_so_id = $1", allocationTest, true],
  [targetPath, "drop child source alias", ").map((/** @type {Record<string, any>} */ row) => row.local_line_key)]),", ").map((/** @type {Record<string, any>} */ row) => undefined)]),", allocationTest, true],
  [targetPath, "accept missing line lineage", "if (mapped.length !== 1)", "if (false)", allocationTest, false],
  ["public/operator.js", "subtract received twice", 'if (Object.hasOwn(line || {}, "original_quantity")) { return Math.max(0, qty(line.quantity)); }',
    'if (false) { return Math.max(0, qty(line.quantity)); }', uiTest, true]
];
for (const [index, [file, name, before, after, testFile, properties]] of quantityMutants.entries()) {
  const contents = currentSources[file];
  assert.equal(contents.split(before).length, 2, name);
  const root = sourceCopy({ [file]: contents.replace(before, after) });
  try {
    for (const layer of properties ? ["focused", "properties"] : ["focused"]) {
      run(`quantity-mutant-${index + 1}-${layer}`, process.execPath,
        ["--test", ...(layer === "properties" ? ["--test-name-pattern=property:"] : []), testFile],
        { cwd: root, accept: (result, output) => result.status !== 0 && /ERR_ASSERTION|Property failed after|OPERATOR_NETSUITE_POSTING_LINE_MAPPING_UNRESOLVED|column "source_po_id" does not exist/.test(output) });
      mutationResults.push({ name, layer, killed: true });
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
}
writeFileSync(`${directory}/mutations.json`, JSON.stringify(mutationResults, null, 2));
}

const baseline = sourceCopy(baselineSources);
try {
  const lintArgs = ["--config", "tools/operator-receiving-identity-eslint.config.mjs", "--format", "json", ...files.filter(file => /\.(?:js|mjs)$/.test(file))];
  const lintBaseline = run("lint-baseline", path.resolve("node_modules/.bin/eslint"), lintArgs, { cwd: baseline, accept: result => result.status <= 1 });
  const lintMessages = output => JSON.parse(output).flatMap(file => file.messages.map(message => ({
    file: path.relative(file.filePath.startsWith(baseline) ? baseline : process.cwd(), file.filePath),
    rule: message.ruleId, message: message.message.replace(/on line \d+ column \d+/g, "on an existing line")
  })));
  const baselineMessages = lintMessages(lintBaseline);
  run("lint", "node_modules/.bin/eslint", lintArgs, { accept: (_result, output) => {
    const current = lintMessages(output);
    return current.every(message => baselineMessages.some(prior => JSON.stringify(prior) === JSON.stringify(message)))
      && current.filter(message => !runtimeFiles.includes(message.file)).length === 0;
  } });
  const typeArgs = ["--project", "tsconfig.mbt.json", "--noEmit", "--pretty", "false"];
  const typesBefore = run("types-baseline", path.resolve("node_modules/.bin/tsc"), typeArgs, { cwd: baseline, accept: result => result.status <= 2 });
  const errors = output => output.split("\n").filter(line => line.includes("error TS")).map(line => line.replace(/\(\d+,\d+\)/, "")).sort();
  assert.equal(errors(typesBefore).length, JSON.parse(readFileSync("test/operator-receiving-identity-baseline.json", "utf8")).typescript_errors);
  run("types", "node_modules/.bin/tsc", typeArgs, { accept: (_result, output) =>
    errors(output).every(error => errors(typesBefore).includes(error)) });
} finally { rmSync(baseline, { recursive: true, force: true }); }
for (const file of runtimeFiles.filter(candidate => candidate.endsWith(".js"))) { run(`syntax-${path.basename(file)}`, process.execPath, ["--check", file]); }
run("secrets", process.execPath, ["test/support/scan-diff-secrets.mjs", ...files]);
for (const [file, contents] of Object.entries(currentSources)) { assert.equal(readFileSync(file, "utf8"), contents); }
console.log("Operator receiving identity verification completed.");
