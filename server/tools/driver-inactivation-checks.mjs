import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { cp, mkdtemp, readFile, readdir, rm, symlink, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { ESLint } from "eslint";
import { runNodeTestFilesIsolated } from "../test/support/test-database-isolation.mjs";
import { buildIsolatedTestEnvironment } from "../test/support/test-foundation.mjs";
import { copyDriverTestSources, withDriverInactivationBaseline } from "./driver-inactivation-baseline.mjs";

const root = process.cwd();
const mode = process.argv[2] || "gauntlet";
const targets = ["test/dispatch/unit/driver-inactivation-planning.test.js", "test/dispatch/integration/driver-inactivation.test.js"];
const changed = ["src/driver-execution-access.js", "src/driver-repository.js", "src/dispatch-setup-repository.js",
  "src/dispatch-fleet-status.js", "src/server.js", "public/dispatch-setup.js", "src/mbt/bin-dispatch-service.js",
  "src/mbt/bin-planning-assignments.js"];
const environment = buildIsolatedTestEnvironment(process.env, { databaseUrl: process.env.DATABASE_URL });
const baselineFiles = [
  "test/mbt/unit/driver-plan-date-execution-wiring.contract.test.js",
  "test/mbt/unit/driver-camera-ordinary-upload.test.js",
  "test/mbt/integration/driver-live-route-prefix-lock.integration.test.js",
  "test/dispatch/integration/scm-pob03658-split-driver-lifecycle.red.test.js",
  "test/mbt/unit/driver-pwa-recovery-assets.test.js",
  "src/dispatch-driver-order-harness.js",
  "test/mbt/unit/driver-pwa-site-reset.test.js",
  "test/mbt/unit/driver-pwa-cache-repair.test.js",
  "test/mbt/unit/driver-pwa-ux-regressions.test.js"
];

async function filesUnder(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) { files.push(...await filesUnder(filename)); }
    else { files.push(filename); }
  }
  return files;
}

async function tests(files, label, env = environment) {
  assert.equal(await runNodeTestFilesIsolated(files, { environment: env, label }), 0, `${label} failed`);
}

function command(args, options = {}) {
  const result = spawnSync(process.execPath, args, { cwd: root, env: environment, encoding: "utf8", maxBuffer: 20 * 1024 * 1024, ...options });
  if (result.stdout) { process.stdout.write(result.stdout); }
  if (result.stderr) { process.stderr.write(result.stderr); }
  assert.equal(result.status, 0, args.join(" "));
}

async function staticChecks() {
  for (const file of [...changed, ...targets]) { command(["--check", file]); }
  const eslint = new ESLint({ overrideConfigFile: true, overrideConfig: [{
    files: ["**/*.{js,mjs}"], languageOptions: { ecmaVersion: "latest", sourceType: "module",
      globals: { console: "readonly", process: "readonly", Buffer: "readonly", setTimeout: "readonly", clearTimeout: "readonly",
        fetch: "readonly", URL: "readonly", structuredClone: "readonly" } },
    rules: { "no-unused-vars": ["error", { argsIgnorePattern: "^_" }], "no-unreachable": "error",
      "no-constant-condition": "error", "no-dupe-args": "error", "no-dupe-keys": "error" }
  }] });
  const results = await eslint.lintFiles(["src/driver-execution-access.js", ...targets, "tools/driver-inactivation-checks.mjs", "tools/driver-inactivation-baseline.mjs"]);
  const formatted = await (await eslint.loadFormatter("stylish")).format(results);
  if (formatted) { process.stdout.write(formatted); }
  assert.equal(results.reduce((count, result) => count + result.errorCount + result.warningCount, 0), 0);
  command(["node_modules/typescript/bin/tsc", "--noEmit", "--allowJs", "--checkJs", "false", "--skipLibCheck",
    "--module", "nodenext", "--target", "es2022", "src/driver-execution-access.js"]);
  console.log("Static checks: syntax, focused lint, execution-guard types passed.");
}

async function regressions() {
  const files = (await filesUnder("test/mbt")).concat(await filesUnder("test/dispatch"))
    .filter(file => /\/(unit|contracts|property|integration|adversarial|concurrency)\//u.test(file)
      && /driver.*\.test\.(js|mjs)$/u.test(path.basename(file)) && !/browser/u.test(file));
  files.push("test/mbt/integration/p3-bin-confirmation-coverage-hardening.test.js",
    "src/dispatch-fleet-status-harness.js", "src/dispatch-fleet-status-endpoint-harness.js",
    "src/verify-dispatch-fleet.js", "src/dispatch-driver-order-harness.js");
  // Deterministic shuffled order; every file also gets a fresh database clone.
  files.sort((a, b) => createHash("sha256").update(`20261029:${a}`).digest("hex")
    .localeCompare(createHash("sha256").update(`20261029:${b}`).digest("hex")));
  await compareBaselineFailures();
  await tests(files.filter(file => !baselineFiles.includes(file)), "driver inactivation regressions (seed 20261029)");
}

function observedFailures(directory, file) {
  const result = spawnSync(process.execPath, ["tools/driver-inactivation-checks.mjs", "files", file], {
    cwd: directory, env: environment, encoding: "utf8", maxBuffer: 20 * 1024 * 1024
  });
  const output = `${result.stdout || ""}\n${result.stderr || ""}`.replaceAll(directory, root);
  const failures = [...new Set(output.split("\n").filter(line => line.startsWith("✖ ") && line !== "✖ failing tests:")
    .map(line => line.replace(/ \([\d.]+ms\)$/u, "")))].sort();
  const counts = output.match(/^ℹ (?:tests|pass|fail|cancelled) \d+$/gmu) || [];
  const diagnostics = [...new Set(output.split("\n").map(line => line.trim())
    .filter(line => /^(?:AssertionError|ReferenceError|TypeError|Error|error:)/u.test(line))
    .map(line => line.replace(/[a-f0-9]{6,}/giu, "<id>")))].sort();
  assert.equal(result.status, 1, output);
  assert(failures.length > 0, output);
  return { failures, counts, diagnostics };
}

async function compareBaselineFailures() {
  await withDriverInactivationBaseline(root, async scratch => {
    for (const file of baselineFiles) {
      const baseline = observedFailures(scratch, file);
      const candidate = observedFailures(root, file);
      assert.deepEqual(candidate, baseline, `New regression in ${file}`);
      console.log(`BASELINE UNCHANGED: ${file}: ${candidate.failures.join("; ")} (${candidate.counts.join(", ")})`);
    }
  });
}

async function mutations() {
  const scratch = await mkdtemp(path.join(root, "test-artifacts", "driver-inactivation-mutants-"));
  try {
    for (const directory of ["src", "public", "contracts", "migrations"]) {
      await cp(path.join(root, directory), path.join(scratch, directory), { recursive: true });
    }
    await copyDriverTestSources(root, scratch);
    await cp(path.join(root, "package.json"), path.join(scratch, "package.json"));
    await symlink(path.join(root, "node_modules"), path.join(scratch, "node_modules"));
    await tests(targets.map(file => path.join(scratch, file)), "mutation workspace control");
    const mutants = [
      ["inactive execution allowed", "src/driver-execution-access.js", "if (drivers.rows.some(driver => driver.active === false))", "if (false)"],
      ["canonical assignment ignored", "src/driver-execution-access.js", "OR EXISTS (", "OR false AND EXISTS ("],
      ["active driver execution blocked", "src/driver-execution-access.js", "driver.active === false", "driver.active === true"],
      ["completion races inactivation", "src/driver-execution-access.js", "FOR SHARE OF driver", ""],
      ["inactivation blocks planning", "src/dispatch-fleet-status.js", "if (!resolvedDriver)", "if (!resolvedDriver || resolvedDriver.active === false)"],
      ["unknown driver validation removed", "src/dispatch-fleet-status.js", "if (!resolvedDriver)", "if (false)"]
    ];
    for (const [name, file, from, to] of mutants) {
      const filename = path.join(scratch, file);
      const original = await readFile(filename, "utf8");
      assert.equal(original.split(from).length, 2, `Unique mutation anchor: ${name}`);
      try {
        await writeFile(filename, original.replace(from, to));
        const result = await runNodeTestFilesIsolated(targets.map(file => path.join(scratch, file)), {
          environment, label: `mutant: ${name}`
        });
        assert.equal(result, 1, `Surviving mutant: ${name}`);
      } finally { await writeFile(filename, original); }
      console.log(`KILLED: ${name}`);
    }
    console.log(`Manual mutation: ${mutants.length}/${mutants.length} killed.`);
  } finally { await rm(scratch, { recursive: true, force: true }); }
}

async function coverage() {
  const directory = path.join(root, "test-artifacts", "driver-inactivation-coverage");
  await rm(directory, { recursive: true, force: true });
  command(["node_modules/c8/bin/c8.js", "--all=false", "--check-coverage=false",
    "--include=src/driver-execution-access.js", "--include=src/dispatch-fleet-status.js",
    `--temp-directory=${directory}/raw`, `--report-dir=${directory}`, "--reporter=text", "--reporter=json-summary",
    "node", "tools/driver-inactivation-checks.mjs", "target"]);
  const report = JSON.parse(await readFile(path.join(directory, "coverage-summary.json"), "utf8"));
  const guard = Object.entries(report).find(([name]) => name.endsWith("/src/driver-execution-access.js"))?.[1];
  assert.equal(guard?.lines.pct, 100);
  console.log(`Execution guard coverage: ${guard.lines.covered}/${guard.lines.total} lines; ${guard.branches.covered}/${guard.branches.total} branches.`);
}

async function sourceState() {
  const files = [...(await filesUnder("src")), ...(await filesUnder("public")), ...targets,
    "package-lock.json", "tools/driver-inactivation-checks.mjs", "tools/driver-inactivation-baseline.mjs"].sort();
  const hash = createHash("sha256");
  for (const file of files) { hash.update(file).update("\0").update(await readFile(file)).update("\0"); }
  console.log(`Source SHA256 (src + public + acceptance tests + lockfile + runner): ${hash.digest("hex")}`);
  console.log(`Node ${process.version}; tools pinned in package-lock.json.`);
}

assert.equal(process.env.MBT_TEST_ISOLATED, "1", "Use docker/run-isolated-tests.sh");
await mkdir(path.join(root, "test-artifacts"), { recursive: true });
if (mode === "target") {
  await tests(targets, "driver inactivation acceptance");
} else if (mode === "files") {
  await tests(process.argv.slice(3), "driver inactivation selected files");
} else if (mode === "bin-red") {
  await tests([...targets, "test/mbt/integration/p3-bin-confirmation-coverage-hardening.test.js",
    "test/mbt/integration/bin-planning-driver.test.js"], "inactive BIN planning confirmation");
} else if (mode === "regressions") {
  await regressions();
} else if (mode === "gauntlet") {
  await staticChecks();
  await tests(targets, "driver inactivation acceptance");
  await regressions();
  await coverage();
  await mutations();
  await tests([...targets].reverse(), "driver inactivation final reversed order");
  await sourceState();
} else { throw new Error(`Unknown mode: ${mode}`); }
