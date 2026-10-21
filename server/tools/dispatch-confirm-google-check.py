"""One-command, isolated verification of the captured Confirm Google overlay.

Run: python3 tools/dispatch-confirm-google-check.py
Only disposable/offline containers are used; Google and production are never called.
The existing recency checker supplies shared TAP/static-diagnostic utilities.
"""
from concurrent.futures import ThreadPoolExecutor
import collections
import datetime
import difflib
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys

SERVER = Path(__file__).resolve().parents[1]
OUT = SERVER / "test-artifacts/dispatch-confirm-google"
BASELINE = OUT / "production-before"
CANDIDATE = OUT / "candidate"
RELEASE = SERVER / "deployments/dispatch-confirm-google-20260930"
FILE = "public/dispatch.js"
IMAGE = "mbbs-bin-planning-test:20260927"
MAPS = ["test/dispatch/frontend/dispatch-google-map-redraw.red.test.js",
        "test/dispatch/frontend/dispatch-map-preview-persistence.test.js",
        "test/mbt/unit/google-maps-gateway.red.test.js"]
ADJACENT = ["test/dispatch/frontend/dispatch-save-reliability.test.js",
            "test/dispatch/property/dispatch-save-reliability.test.js",
            "test/dispatch/frontend/dispatch-planner-performance.contract.test.js",
            "test/dispatch/frontend/google-maps-usage-control.contract.test.js"]
FOCUSED = "test/dispatch/frontend/dispatch-confirm-google-routes.test.js"
DB = "test/dispatch/integration/dispatch-confirm-google-route-persistence.test.js"

spec = importlib.util.spec_from_file_location("dispatch_check_common", SERVER / "tools/dispatch-recent-cards-check.py")
common = importlib.util.module_from_spec(spec)
spec.loader.exec_module(common)
common.OUT = OUT


def hashes(tree):
    return {str(path.relative_to(tree)): hashlib.sha256(path.read_bytes()).hexdigest()
            for folder in ("src", "public", "migrations")
            for path in (tree / folder).rglob("*") if path.is_file()}


def inputs():
    before, after = hashes(BASELINE), hashes(CANDIDATE)
    metadata = json.loads((OUT / "baseline-metadata.json").read_text())
    assert before == metadata["runtime"], "Captured live baseline changed"
    assert before.keys() == after.keys(), "Runtime file inventory changed"
    assert [file for file in before if before[file] != after[file]] == [FILE], "Overlay is not exactly public/dispatch.js"
    for file, digest in metadata["packageHashes"].items():
        assert hashlib.sha256((BASELINE / file).read_bytes()).hexdigest() == digest
        assert hashlib.sha256((CANDIDATE / file).read_bytes()).hexdigest() == digest
    tests = MAPS + ADJACENT + [FOCUSED, DB, "test/support/google-map-redraw-fixture.mjs"]
    return {"sourceHashes": {FILE: after[FILE]}, "testHashes": {
        file: hashlib.sha256((SERVER / file).read_bytes()).hexdigest() for file in tests},
        "baselineSignature": hashlib.sha256(json.dumps(before, sort_keys=True).encode()).hexdigest(),
        "runtimeFiles": len(before), "validationToolHashes": {
            file: hashlib.sha256((SERVER / file).read_bytes()).hexdigest() for file in
            ("tools/dispatch-confirm-google-check.py", "tools/dispatch-recent-cards-check.py",
             "tools/dispatch-fulfilled-so-eslint.config.mjs", "eslint.mbt.config.js")}}


def run(name, command):
    (OUT / "commands").mkdir(exist_ok=True)
    (OUT / "commands" / (name + ".json")).write_text(json.dumps(command, indent=2) + "\n")
    return common.run(name, command)


def offline(name, source, args, overrides=()):
    command = ["sudo", "-n", "docker", "run", "--rm", "--network", "none", "--ipc=host",
               "--user", f"{os.getuid()}:{os.getgid()}", "-e", "MBBS_ENV_FILE=/nonexistent",
               "-e", "NODE_ENV=test", "-e", "NETSUITE_DIRECT_ACCESS_ENABLED=false"]
    for folder in ("src", "public", "migrations"):
        command += ["-v", f"{source / folder}:/app/{folder}:ro"]
    for folder in ("test", "tools", "contracts"):
        command += ["-v", f"{SERVER / folder}:/app/{folder}:ro"]
    command += ["-v", f"{SERVER / 'eslint.mbt.config.js'}:/app/eslint.mbt.config.js:ro",
                "-v", f"{source / 'package.json'}:/app/package.json:ro",
                "-v", f"{OUT}:/app/test-artifacts/dispatch-confirm-google"]
    for path, destination in overrides:
        command += ["-v", f"{path}:{destination}:ro"]
    return run(name, command + ["--entrypoint", "node", IMAGE, *args])


def suite(name, source, tests, coverage=False):
    args = []
    if coverage:
        args += ["node_modules/c8/bin/c8.js", "--all=false", "--check-coverage=false",
                 "--include=public/dispatch.js", "--reporter=json", "--reporter=json-summary",
                 "--reports-dir=test-artifacts/dispatch-confirm-google/coverage",
                 "--temp-directory=test-artifacts/dispatch-confirm-google/coverage-raw", "node",
                 "--require", "/app/test-artifacts/dispatch-confirm-google/coverage-hook.cjs"]
    code, text = offline(name, source, args + ["--test", "--test-concurrency=1", *tests])
    result = common.tap(code, text)
    assert code == (1 if result["fail"] else 0), "Wrapper exit disagrees with TAP failures: " + name
    return result


def static():
    tree = OUT / "baseline-static"
    if tree.exists():
        shutil.rmtree(tree)
    for folder in ("src", "public"):
        shutil.copytree(BASELINE / folder, tree / folder)
    shutil.copy2(BASELINE / "package.json", tree / "package.json")
    script = common.STATIC_JS.replace("dispatch-recent-cards", "dispatch-confirm-google").replace(
        '["c8", "eslint", "typescript"]', '["c8", "eslint", "typescript", "espree", "istanbul-lib-coverage"]')
    (OUT / "static-check.mjs").write_text(script)
    code, _ = offline("static", CANDIDATE, ["test-artifacts/dispatch-confirm-google/static-check.mjs", json.dumps([FILE])])
    assert code == 0, "Static runner failed"
    results = json.loads((OUT / "static-results.json").read_text())
    return {**{key: {"baselineFindings": len(results[key]["baseline"]),
                    "candidateFindings": len(results[key]["candidate"]),
                    "newFindings": common.differential(results[key]["baseline"], results[key]["candidate"])}
               for key in ("lint", "types")}, "tools": results["tools"]}


# Record only original executable AST ranges actually present in a compiled
# fixture body. Full-length whitespace scaffolds must never cover omitted code.
HOOK = r'''
const vm = require("node:vm");
const fs = require("node:fs");
const {syncBuiltinESMExports} = require("node:module");
const {parse} = require("/app/node_modules/espree");
const path = "/app/public/dispatch.js";
const source = fs.readFileSync(path, "utf8");
const ast = parse(source, {ecmaVersion:"latest",sourceType:"script",range:true,loc:true});
const executable=[];
function visit(node) {
  if(!node || typeof node!=="object")return;
  if(typeof node.type==="string" && /Statement$|Declaration$|Expression$|^VariableDeclarator$/.test(node.type)
    && !["BlockStatement","EmptyStatement"].includes(node.type)) executable.push(node);
  for(const [key,value] of Object.entries(node))if(!["loc","range"].includes(key)) {
    if(Array.isArray(value))value.forEach(visit);else if(value && typeof value==="object")visit(value);
  }
}
visit(ast);
const compiled = new Set();
const original = vm.compileFunction;
vm.compileFunction = function(code, params, options={}) {
  if(options.filename===path)for(const node of executable) {
    const [start,end]=node.range;
    if(code.slice(start,end)===source.slice(start,end))compiled.add(start+":"+end);
  }
  return Reflect.apply(original,this,arguments);
};
syncBuiltinESMExports();
process.on("exit",()=>fs.writeFileSync(`/app/test-artifacts/dispatch-confirm-google/compiled-${process.pid}.json`,JSON.stringify([...compiled])));
'''

COVERAGE = r'''
import {readFileSync,writeFileSync,readdirSync} from "node:fs";
import {parse} from "espree";
import coverage from "istanbul-lib-coverage";
const out="test-artifacts/dispatch-confirm-google";
const file="public/dispatch.js";
const source=readFileSync(file,"utf8");
const ast=parse(source,{ecmaVersion:"latest",sourceType:"script",loc:true,range:true});
const compiled=new Set(readdirSync(out).filter(x=>/^compiled-\d+\.json$/.test(x))
  .flatMap(x=>JSON.parse(readFileSync(`${out}/${x}`))));
const executable=new Map();
function visit(node, owner=null) {
  if(!node||typeof node!=="object")return;
  if(node.type==="FunctionDeclaration")owner=node.id.name;
  if(typeof node.type==="string" && /Statement$|Declaration$|Expression$|^VariableDeclarator$/.test(node.type)
    && !["BlockStatement","EmptyStatement"].includes(node.type)) {
    const line=node.loc.start.line;
    if(!executable.has(line))executable.set(line,[]);
    executable.get(line).push({node,owner});
  }
  for(const [key,value] of Object.entries(node))if(!["loc","range"].includes(key)) {
    if(Array.isArray(value))value.forEach(child=>visit(child,owner));else if(value&&typeof value==="object")visit(value,owner);
  }
}
visit(ast);
const map=coverage.createCoverageMap(JSON.parse(readFileSync(`${out}/coverage/coverage-final.json`)));
const key=map.files().find(path=>path.endsWith("/"+file));
if(!key)throw Error("No application coverage emitted");
const lineCoverage=map.fileCoverageFor(key).getLineCoverage();
const functionCoverage=map.fileCoverageFor(key).toJSON();
const executedFunctions=new Set(Object.entries(functionCoverage.fnMap)
  .filter(([id])=>functionCoverage.f[id]>0).map(([,node])=>node.name));
const changed=JSON.parse(readFileSync(`${out}/changed-lines.json`));
const report={total:0,covered:0,uncovered:[],omittedFromFixture:[],nonStatementLines:[],compiledNodes:compiled.size,
  method:"Changed executable AST lines intersected with compiled original ranges, executed containing declarations, and merged c8 line counters; line coverage, not per-node or branch coverage",
  executedFunctions:[...executedFunctions]};
for(const line of changed) {
  const nodes=executable.get(line);
  if(!nodes){report.nonStatementLines.push(line);continue;}
  report.total++;
  const present=nodes.some(({node,owner})=>compiled.has(node.range.join(":")) && (!owner||executedFunctions.has(owner)));
  if(present&&lineCoverage[line]>0)report.covered++;
  else {report.uncovered.push({file,line});if(!present)report.omittedFromFixture.push(line);}
}
writeFileSync(`${out}/changed-line-coverage.json`,JSON.stringify(report,null,2));
'''


def coverage():
    before, after = (BASELINE / FILE).read_text().splitlines(), (CANDIDATE / FILE).read_text().splitlines()
    lines = [line for tag, _, _, start, end in difflib.SequenceMatcher(a=before, b=after, autojunk=False).get_opcodes()
             if tag in ("replace", "insert") for line in range(start + 1, end + 1)]
    (OUT / "changed-lines.json").write_text(json.dumps(lines))
    (OUT / "coverage-check.mjs").write_text(COVERAGE)
    code, _ = offline("changed-coverage", CANDIDATE, ["test-artifacts/dispatch-confirm-google/coverage-check.mjs"])
    assert code == 0, "Coverage analysis failed"
    return json.loads((OUT / "changed-line-coverage.json").read_text())


def mutants():
    source = (CANDIDATE / FILE).read_text()
    cases = [
        ("missing-only", "routeLoadsNeedingEstimate({ refreshAll: true })", "routeLoadsNeedingEstimate({ refreshAll: false })"),
        ("browser-cache-used", '!forceRefresh && reason !== "manual_refresh" && applyCachedRouteEstimate', 'reason !== "manual_refresh" && applyCachedRouteEstimate'),
        ("warning-discarded", "plan.googleRouteWarnings = googleRouteRefresh?.failed || [];", "plan.googleRouteWarnings = [];"),
        ("manual-flight-not-awaited", "if (backgroundRouteRequests.has(requestKey)) return backgroundRouteRequests.get(requestKey);", "if (backgroundRouteRequests.has(requestKey)) return null;")]
    results = []
    for name, before, after in cases:
        assert source.count(before) == 1, "Mutation anchor absent/ambiguous: " + name
        path = OUT / ("mutant-" + name + ".js")
        path.write_text(source.replace(before, after, 1))
        code, text = offline("mutant-" + name, CANDIDATE, ["--test", FOCUSED], [(path, "/app/public/dispatch.js")])
        result = common.tap(code, text)
        assert code == 1 and result["fail"] > 0 and "ERR_ASSERTION" in text, "Mutant survived or failed outside assertions: " + name
        results.append({"name": name, "killed": True, "replacement": [before, after],
                        "mutantSha256": hashlib.sha256(path.read_bytes()).hexdigest(), "tap": result})
    return results


def database():
    artifact = OUT / "candidate-db-artifacts"
    check = os.path.relpath(artifact, SERVER / "test-artifacts/mbt-bin-planning/checks")
    code, text = run("candidate-db", ["sudo", "-n", "env", f"BIN_PLANNING_SOURCE_ROOT={CANDIDATE}",
        f"BIN_PLANNING_CHECK={check}", "bash", str(SERVER / "tools/bin-planning-test.sh"), "node", "--test", DB])
    result = common.tap(code, text)
    assert result["pass"] == 3 and result["fail"] == result["cancelled"] == result["skipped"] == code == 0
    return {**result, "artifacts": str(artifact), "googleBoundary": "fixture", "productionAccess": False}


def main():
    OUT.mkdir(exist_ok=True)
    result = {"passed": False, "startedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(),
              "productionAccess": False, "paidGoogleCalls": 0, **inputs(), "checks": {}}
    checks = result["checks"]
    try:
        if "--static-only" in sys.argv:
            checks["static"] = static()
            assert not checks["static"]["lint"]["newFindings"] and not checks["static"]["types"]["newFindings"]
            return
        for path in OUT.glob("compiled-*.json"):
            path.unlink()
        for folder in ("coverage", "coverage-raw"):
            if (OUT / folder).exists():
                shutil.rmtree(OUT / folder)
        code, image_id = run("test-image", ["sudo", "-n", "docker", "image", "inspect", IMAGE, "--format", "{{.Id}}"])
        assert code == 0 and image_id.strip().startswith("sha256:"), "Disposable test image unavailable"
        result["testImage"] = {"tag": IMAGE, "imageId": image_id.strip()}
        (OUT / "coverage-hook.cjs").write_text(HOOK)
        with ThreadPoolExecutor(max_workers=3) as pool:
            old = pool.submit(suite, "baseline-suite", BASELINE, MAPS + ADJACENT)
            new = pool.submit(suite, "candidate-suite", CANDIDATE, MAPS + ADJACENT + [FOCUSED], True)
            diagnostics = pool.submit(static)
            checks["baselineSuite"], checks["candidateSuite"], checks["static"] = old.result(), new.result(), diagnostics.result()
        before, after = checks["baselineSuite"], checks["candidateSuite"]
        checks["newFailures"] = list((collections.Counter(after["failures"]) - collections.Counter(before["failures"])).elements())
        assert not checks["newFailures"], "New regression failures"
        assert after["cancelled"] == 0 and after["skipped"] == before["skipped"] == 0
        assert after["tests"] > before["tests"], "Focused tests absent"
        checks["newFrontendTests"] = after["tests"] - before["tests"]
        assert checks["newFrontendTests"] == 14, "Expected focused frontend tests did not all run"
        assert not checks["static"]["lint"]["newFindings"], "New ESLint findings"
        assert not checks["static"]["types"]["newFindings"], "New TypeScript findings"
        checks["changedLineCoverage"] = coverage()
        assert not checks["changedLineCoverage"]["uncovered"], "Changed executable lines uncovered"
        checks["mutants"] = mutants()
        checks["databasePersistence"] = database()
        assert inputs() == {key: result[key] for key in ("sourceHashes", "testHashes", "baselineSignature", "runtimeFiles", "validationToolHashes")}, "Inputs changed during verification"
        result["passed"] = True
    except Exception as error:
        result["error"] = f"{type(error).__name__}: {error}"
        raise
    finally:
        result["sourceHashesUnchanged"] = inputs()["sourceHashes"] == result["sourceHashes"]
        result["finishedAt"] = datetime.datetime.now(datetime.timezone.utc).isoformat()
        target = "static-validation.json" if "--static-only" in sys.argv else "validation.json"
        (OUT / target).write_text(json.dumps(result, indent=2) + "\n")
        if result["passed"]:
            RELEASE.mkdir(exist_ok=True)
            (RELEASE / "verified.json").write_text(json.dumps(result, indent=2) + "\n")
        print(json.dumps({"passed": result["passed"], "sourceHashes": result["sourceHashes"],
                          "artifact": str(OUT / target), "completedLayers": list(checks),
                          **({"error": result["error"]} if "error" in result else {})}), flush=True)


if __name__ == "__main__":
    main()
