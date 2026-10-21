"""Validate captured Dispatch recency sources with disposable/offline tests only.

Run: python3 tools/dispatch-recent-cards-check.py
The entry point never inspects or changes production containers or databases.
It retains TAP, static diagnostics, mutations and changed-line coverage evidence.
"""
import collections
from concurrent.futures import ThreadPoolExecutor
import datetime
import difflib
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys

SERVER = Path(__file__).resolve().parents[1]
OUT = SERVER / "test-artifacts/dispatch-recent-cards"
BASELINE = OUT / "production-before"
CANDIDATE = OUT / "candidate"
IMAGE = "mbbs-bin-planning-test:20260927"
FILES = ["src/dispatch-repository.js", "src/dispatch-order-recency.js",
         "src/dispatch-order-catalog-repository.js", "src/dispatch-planner-optimization.js",
         "src/dispatch-delivery-group-repository.js", "src/server.js",
         "migrations/242_dispatch_order_first_seen.sql"]
JS_FILES = [file for file in FILES if file.endswith(".js")]
PROPERTY = "test/dispatch/property/dispatch-order-recency.property.test.js"
AFFECTED = [
    "test/dispatch/integration/dispatch-order-catalog.red.test.js",
    "test/dispatch/integration/dispatch-global-order-group-pool.red.test.js",
    "test/dispatch/integration/dispatch-global-derived-order-pool.red.test.js",
    "test/dispatch/integration/dispatch-split-pickup-pool.test.js",
    "test/dispatch/integration/dispatch-order-db-recency.test.js",
    "test/dispatch/integration/dispatch-fulfilled-so-planning.test.js",
    "test/dispatch/integration/to-cleanup-planning.test.js",
    "test/workload/integration/dispatch-recent-pool.red.test.js",
    "test/dispatch/unit/dispatch-order-pool-policy.test.js",
    "test/dispatch/unit/dispatch-fulfilled-so-policy.test.js",
    "test/dispatch/unit/dispatch-planner-optimization.red.test.js",
    "test/dispatch/property/dispatch-global-order-group-pool.property.test.js"
]
FOCUSED = [PROPERTY, "test/dispatch/integration/dispatch-recent-cards.test.js",
           "test/dispatch/integration/dispatch-derived-recency.test.js",
           "test/dispatch/integration/dispatch-co-pool-recency.test.js",
           "test/dispatch/integration/dispatch-first-seen-migration.test.js"]


def source_hashes():
    return {file: hashlib.sha256((CANDIDATE / file).read_bytes()).hexdigest() for file in FILES}


def baseline_signature():
    runtime = {str(path.relative_to(BASELINE)): hashlib.sha256(path.read_bytes()).hexdigest()
               for folder in ("src", "public", "migrations")
               for path in (BASELINE / folder).rglob("*") if path.is_file()}
    packages = {file: hashlib.sha256((BASELINE / file).read_bytes()).hexdigest()
                for file in ("package.json", "package-lock.json")}
    manifest = json.loads((SERVER / "deployments/dispatch-recent-cards-20260930/manifest.json").read_text())
    assert runtime == manifest["baselineRuntime"], "Captured baseline runtime changed"
    assert packages == manifest["packageHashes"], "Captured baseline packages changed"
    image = manifest["services"]["app"]["before"]["imageId"]
    signature = hashlib.sha256(json.dumps({"runtime": runtime, "packages": packages, "image": image}, sort_keys=True).encode()).hexdigest()
    return {"sha256": signature, "runtimeFiles": len(runtime), "imageId": image}


def run(name, args, env=None):
    log = OUT / (name + ".log")
    print(json.dumps({"check": name, "log": str(log)}), flush=True)
    with log.open("wb") as output:
        result = subprocess.run(args, cwd=SERVER, env=env, stdout=output, stderr=subprocess.STDOUT)
    return result.returncode, log.read_text(errors="replace")


def tap(code, output):
    assert re.search(r"^# tests (\d+)$", output, re.MULTILINE), "Runner emitted no TAP summary; inspect its log"
    counts = {key: int(re.search(rf"^# {key} (\d+)$", output, re.MULTILINE).group(1))
              for key in ("tests", "pass", "fail", "skipped", "cancelled")}
    return {"exitCode": code, **counts,
            "failures": re.findall(r"^not ok \d+ - (.*)$", output, re.MULTILINE),
            "passes": re.findall(r"^ok \d+ - (.*)$", output, re.MULTILINE)}


def db(name, source, tests, coverage=False):
    artifact = OUT / (name + "-artifacts")
    check = os.path.relpath(artifact, SERVER / "test-artifacts/mbt-bin-planning/checks")
    env = dict(os.environ, BIN_PLANNING_SOURCE_ROOT=str(source), BIN_PLANNING_CHECK=check)
    args = ["sudo", "-n", "env", f"BIN_PLANNING_SOURCE_ROOT={source}", f"BIN_PLANNING_CHECK={check}",
            "bash", str(SERVER / "tools/bin-planning-test.sh"), "node"]
    if coverage:
        args += ["node_modules/c8/bin/c8.js", "--all=false", "--check-coverage=false",
                 *["--include=" + file for file in JS_FILES],
                 "--reporter=json", "--reporter=json-summary",
                 "--reports-dir=test-artifacts/coverage", "--temp-directory=/tmp/dispatch-recent-cards-c8", "node"]
    args += ["--test", "--test-concurrency=1", *tests]
    code, output = run(name, args, env)
    report = tap(code, output)
    report["artifacts"] = str(artifact)
    return report


def offline(name, source, args, extra_mounts=()):
    command = ["sudo", "-n", "docker", "run", "--rm", "--network", "none", "--ipc=host",
               "--user", f"{os.getuid()}:{os.getgid()}", "-e", "MBBS_ENV_FILE=/nonexistent",
               "-e", "NODE_ENV=test", "-e", "NETSUITE_DIRECT_ACCESS_ENABLED=false"]
    for folder in ("src", "public", "migrations"):
        command += ["-v", f"{source / folder}:/app/{folder}:ro"]
    for folder in ("test", "tools", "contracts"):
        command += ["-v", f"{SERVER / folder}:/app/{folder}:ro"]
    command += ["-v", f"{SERVER / 'eslint.mbt.config.js'}:/app/eslint.mbt.config.js:ro",
                "-v", f"{source / 'package.json'}:/app/package.json:ro",
                "-v", f"{OUT}:/app/test-artifacts/dispatch-recent-cards",
                "-v", f"{BASELINE / 'src'}:/baseline/src:ro",
                "-v", f"{BASELINE / 'package.json'}:/baseline/package.json:ro"]
    for path, target in extra_mounts:
        command += ["-v", f"{path}:{target}:ro"]
    return run(name, command + ["--entrypoint", "node", IMAGE, *args])


STATIC_JS = r'''
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
const out = "test-artifacts/dispatch-recent-cards";
const baselinePrefix = `${out}/baseline-static/`;
const files = JSON.parse(process.argv[2]);
function run(name, args, options = {}) {
  const result = spawnSync(process.execPath, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, ...options });
  writeFileSync(`${out}/${name}.log`, (result.stdout || "") + (result.stderr || ""));
  assert.equal(result.error, undefined);
  assert.ok([0, 1, 2].includes(result.status), `${name} status ${result.status}`);
  return result;
}
const lint = { baseline: [], candidate: [] };
for (const file of files) {
  for (const phase of ["baseline", "candidate"]) {
    const path = phase === "baseline" ? `${baselinePrefix}${file}` : file;
    if (!existsSync(path)) continue;
    const result = run(`lint-${phase}-${file.replaceAll("/", "-")}`, ["node_modules/eslint/bin/eslint.js",
      "--config", "tools/dispatch-fulfilled-so-eslint.config.mjs", "--format", "json", "--stdin", "--stdin-filename", file],
      { input: readFileSync(path, "utf8") });
    for (const row of JSON.parse(result.stdout)) for (const item of row.messages) {
      lint[phase].push({file, ruleId:item.ruleId, message:item.message, nodeType:item.nodeType});
    }
  }
  assert.equal(run(`syntax-${file.replaceAll("/", "-")}`, ["--check", file]).status, 0);
}
const types = {};
for (const phase of ["baseline", "candidate"]) {
  const args = files.map(file => phase === "baseline" ? `${baselinePrefix}${file}` : file).filter(existsSync);
  const result = run(`types-${phase}`, ["node_modules/typescript/bin/tsc", "--allowJs", "true", "--checkJs", "true",
    "--noEmit", "true", "--skipLibCheck", "true", "--target", "ES2023", "--module", "NodeNext", "--pretty", "false", ...args]);
  types[phase] = (result.stdout + result.stderr).split("\n").filter(line => line.trim())
    .map(line => line.replace(baselinePrefix, "").replace(/^\/app\//, "").replace(/\(\d+,\d+\): /, ": "));
}
const tools = Object.fromEntries(["c8", "eslint", "typescript"].map(name =>
  [name, JSON.parse(readFileSync(`node_modules/${name}/package.json`)).version]));
writeFileSync(`${out}/static-results.json`, JSON.stringify({lint,types,tools:{node:process.version,...tools}}, null, 2));
'''

COVERAGE_JS = r'''
import assert from "node:assert/strict";
import {readFileSync,writeFileSync} from "node:fs";
import {parse} from "espree";
import coverage from "istanbul-lib-coverage";
const out="test-artifacts/dispatch-recent-cards";
const changed=JSON.parse(readFileSync(`${out}/changed-lines.json`));
const map=coverage.createCoverageMap(JSON.parse(readFileSync(`${out}/candidate-suite-artifacts/coverage/coverage-final.json`)));
const report={total:0,covered:0,uncovered:[],files:{}};
for(const [file, lines] of Object.entries(changed)) {
  const ast=parse(readFileSync(file,"utf8"),{ecmaVersion:"latest",sourceType:"module",loc:true});
  const executable=new Set();
  function visit(node) {
    if(!node||typeof node!=="object")return;
    if(typeof node.type==="string"&&(/Statement$|Declaration$|Expression$|^VariableDeclarator$/.test(node.type))
      && !["BlockStatement","EmptyStatement","ImportDeclaration","ExportNamedDeclaration","ExportDefaultDeclaration"].includes(node.type))
      executable.add(node.loc.start.line);
    for(const [key,value] of Object.entries(node))if(key!=="loc") {
      if(Array.isArray(value))for(const child of value)visit(child);
      else if(value&&typeof value==="object")visit(value);
    }
  }
  visit(ast);
  const key=map.files().find(path=>path.endsWith("/"+file));
  assert.ok(key,`Missing instrumentation for ${file}`);
  const covered=key?map.fileCoverageFor(key).getLineCoverage():{};
  const item={changedLines:lines.length,executable:0,covered:0,uncovered:[],nonStatementLines:[]};
  for(const line of lines) {
    if(!executable.has(line)){item.nonStatementLines.push(line);continue;}
    item.executable++;report.total++;
    if(covered[line]>0){item.covered++;report.covered++;}
    else {item.uncovered.push(line);report.uncovered.push({file,line});}
  }
  report.files[file]=item;
}
writeFileSync(`${out}/changed-line-coverage.json`,JSON.stringify(report,null,2));
'''


def differential(before, after):
    allowed = collections.Counter(json.dumps(item, sort_keys=True) for item in before)
    new = []
    for item in after:
        key = json.dumps(item, sort_keys=True)
        if allowed[key]:
            allowed[key] -= 1
        else:
            new.append(item)
    return new


def static_checks():
    baseline_static = OUT / "baseline-static"
    if baseline_static.exists():
        shutil.rmtree(baseline_static)
    shutil.copytree(BASELINE / "src", baseline_static / "src")
    shutil.copytree(BASELINE / "public", baseline_static / "public")
    shutil.copy2(BASELINE / "package.json", baseline_static / "package.json")
    (OUT / "static-check.mjs").write_text(STATIC_JS)
    code, _ = offline("static", CANDIDATE, ["test-artifacts/dispatch-recent-cards/static-check.mjs", json.dumps(JS_FILES)])
    assert code == 0, "Static checker failed; inspect static.log"
    result = json.loads((OUT / "static-results.json").read_text())
    summary = {key: {"baselineFindings": len(result[key]["baseline"]),
                     "candidateFindings": len(result[key]["candidate"]),
                     "newFindings": differential(result[key]["baseline"], result[key]["candidate"])}
               for key in ("lint", "types")}
    summary["tools"] = result["tools"]
    return summary


def mutations():
    original = (CANDIDATE / "src/dispatch-order-recency.js").read_text()
    marker = "export function dispatchOrderFirstSeenAt"
    prefix, arrival = original.split(marker)
    cases = [
        ("activity-before-arrival", original.replace("if (arrival) return arrival;",
          "if (arrival) return validInstant(order.updatedAt) || arrival;")),
        ("oldest-group-member", prefix + marker + arrival.replace("children.sort().at(-1)", "children.sort().at(0)", 1)),
        ("local-co-child-overrides-creation", prefix + marker + arrival.replace("if (localCo) return own;", "", 1))
    ]
    results = []
    for name, mutant in cases:
        assert mutant != original, "Mutant did not change source: " + name
        path = OUT / ("mutant-" + name + ".js")
        path.write_text(mutant)
        code, output = offline("mutant-" + name, CANDIDATE, ["--test", PROPERTY],
                               [(path, "/app/src/dispatch-order-recency.js")])
        result = tap(code, output)
        assert code == 1 and result["fail"] > 0 and "ERR_ASSERTION" in output, "Mutant survived or failed outside assertions: " + name
        results.append({"name": name, "killed": True, "tests": result["tests"], "failingProperties": result["failures"]})
    return results


def changed_coverage():
    changed = {}
    for file in JS_FILES:
        before = (BASELINE / file).read_text().splitlines() if (BASELINE / file).exists() else []
        after = (CANDIDATE / file).read_text().splitlines()
        lines = []
        for tag, _, _, start, end in difflib.SequenceMatcher(a=before, b=after, autojunk=False).get_opcodes():
            if tag in ("replace", "insert"):
                lines.extend(range(start + 1, end + 1))
        changed[file] = lines
    (OUT / "changed-lines.json").write_text(json.dumps(changed, indent=2) + "\n")
    (OUT / "coverage-check.mjs").write_text(COVERAGE_JS)
    code, _ = offline("changed-coverage", CANDIDATE, ["test-artifacts/dispatch-recent-cards/coverage-check.mjs"])
    assert code == 0, "Coverage analysis failed"
    return json.loads((OUT / "changed-line-coverage.json").read_text())


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    result = {"passed": False, "startedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(),
              "sourceHashes": source_hashes(), "checks": {}}
    checks = result["checks"]
    try:
        result["baselineSourceSignature"] = baseline_signature()
        if "--reuse-baseline" in sys.argv:
            previous = json.loads((OUT / "validation.json").read_text())
            assert previous["passed"], "Only a successful prior baseline may be reused"
            if previous.get("baselineSourceSignature"):
                assert previous["baselineSourceSignature"] == result["baselineSourceSignature"], "Baseline signature changed since verification"
            else:
                # Compatibility with the earlier completed validation. Its
                # registered capture is checked in full above; reject recapture.
                assert (OUT / "baseline-metadata.json").stat().st_mtime <= datetime.datetime.fromisoformat(previous["startedAt"]).timestamp(), "Baseline was recaptured after verification"
            baseline = previous["checks"]["baselineSuite"]
            logged = tap(baseline["exitCode"], (OUT / "baseline-suite.log").read_text())
            assert all(logged[key] == baseline[key] for key in ("tests", "pass", "fail", "failures", "skipped", "cancelled")), "Retained baseline log differs from its verified result"
            checks["baselineSuite"] = baseline
            checks["baselineReusedFrom"] = previous["finishedAt"]
            candidate = db("candidate-suite", CANDIDATE, AFFECTED + FOCUSED, coverage=True)
        elif "--resume-baseline" in sys.argv:
            previous = json.loads((OUT / "validation.json").read_text())
            assert previous["sourceHashes"] == result["sourceHashes"], "Candidate changed since the interrupted run"
            assert "all predefined address pools have been fully subnetted" in (OUT / "candidate-suite.log").read_text(), "Resume is only for pre-test network exhaustion"
            assert (OUT / "baseline-metadata.json").stat().st_mtime <= datetime.datetime.fromisoformat(previous["startedAt"]).timestamp(), "Baseline was recaptured after the interrupted run"
            baseline = previous["checks"]["baselineSuite"]
            checks["baselineSuite"] = baseline
            checks["baselineResumedAfterPreTestNetworkExhaustion"] = True
            candidate = db("candidate-suite", CANDIDATE, AFFECTED + FOCUSED, coverage=True)
        else:
            # Each runner creates its own network and database. Some Docker
            # hosts have only one remaining subnet; retry the candidate after
            # baseline cleanup if parallel allocation failed before tests ran.
            with ThreadPoolExecutor(max_workers=2) as runners:
                baseline_run = runners.submit(db, "baseline-suite", BASELINE, AFFECTED)
                candidate_run = runners.submit(db, "candidate-suite", CANDIDATE, AFFECTED + FOCUSED, True)
                baseline = baseline_run.result()
                checks["baselineSuite"] = baseline
                try:
                    candidate = candidate_run.result()
                except AssertionError:
                    assert "all predefined address pools have been fully subnetted" in (OUT / "candidate-suite.log").read_text(), "Candidate runner failed before tests"
                    candidate = db("candidate-suite", CANDIDATE, AFFECTED + FOCUSED, coverage=True)
                    checks["candidateSequentialNetworkFallback"] = True
        checks["candidateSuite"] = candidate
        checks["newFailures"] = list((collections.Counter(candidate["failures"]) - collections.Counter(baseline["failures"])).elements())
        assert not checks["newFailures"], "New test failures: " + json.dumps(checks["newFailures"])
        assert candidate["cancelled"] == 0 and candidate["skipped"] == baseline["skipped"], "Unexpected cancellations/skips"
        assert candidate["tests"] > baseline["tests"], "Focused tests did not run"
        checks["focusedAdditionalTests"] = candidate["tests"] - baseline["tests"]
        checks["static"] = static_checks()
        assert not checks["static"]["lint"]["newFindings"], "New ESLint findings"
        assert not checks["static"]["types"]["newFindings"], "New TypeScript diagnostics"
        checks["mutants"] = mutations()
        checks["changedLineCoverage"] = changed_coverage()
        assert not checks["changedLineCoverage"]["uncovered"], "Uncovered changed executable lines; review changed-line-coverage.json"
        assert source_hashes() == result["sourceHashes"], "Candidate bytes changed during checks"
        result["passed"] = True
    except Exception as error:
        result["error"] = f"{type(error).__name__}: {error}"
        raise
    finally:
        result["sourceHashesUnchanged"] = source_hashes() == result["sourceHashes"]
        result["finishedAt"] = datetime.datetime.now(datetime.timezone.utc).isoformat()
        (OUT / "validation.json").write_text(json.dumps(result, indent=2) + "\n")
        if result["passed"]:
            release = SERVER / "deployments/dispatch-recent-cards-20260930"
            release.mkdir(exist_ok=True)
            (release / "verified.json").write_text(json.dumps(result, indent=2) + "\n")
        print(json.dumps(result), flush=True)


if __name__ == "__main__":
    main()
