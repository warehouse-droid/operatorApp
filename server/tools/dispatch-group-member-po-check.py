"""Offline regression, static, coverage, and mutation evidence for grouped PO links."""
import difflib
import hashlib
import json
from pathlib import Path
import re
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "test-artifacts/dispatch-group-member-po-20261001"
SOURCE = "src/dispatch-repository.js"
TEST = "test/dispatch/unit/dispatch-group-member-po.test.js"
IMAGE = "mbbs-return-batch-browser-test:20260918"
BASELINE = OUT / "baseline/dispatch-repository.js"


def run(label, args, replacement=None, output=False):
    cmd = ["sudo", "-n", "docker", "run", "--rm", "--network", "none",
           "-e", "MBBS_ENV_FILE=/nonexistent", "-e", "NODE_ENV=test"]
    for name in ["src", "public", "test", "tools", "contracts"]:
        cmd += ["-v", str(ROOT / name) + ":/app/" + name + ":ro"]
    for name in ["package.json", "eslint.mbt.config.js", "tsconfig.mbt.json"]:
        cmd += ["-v", str(ROOT / name) + ":/app/" + name + ":ro"]
    if replacement:
        cmd += ["-v", str(replacement) + ":/app/" + SOURCE + ":ro"]
    if output:
        cmd += ["-v", str(OUT) + ":/evidence"]
    cmd += ["--entrypoint", "node", IMAGE, *args]
    with (OUT / (label + ".log")).open("wb") as log:
        result = subprocess.run(cmd, stdout=log, stderr=subprocess.STDOUT)
    lines = (OUT / (label + ".log")).read_text().splitlines()
    return {"exitCode": result.returncode,
            "summary": [line for line in lines if line.startswith(("# tests", "# pass", "# fail", "# skipped"))],
            "failures": [line.split(" - ", 1)[-1] for line in lines if line.startswith("not ok")]}


def save(name, value):
    (OUT / name).write_text(json.dumps(value, indent=2) + "\n")


def suites():
    files = sorted(str(path.relative_to(ROOT)) for folder in ["unit", "property", "adversarial", "frontend"]
                   for path in (ROOT / "test/dispatch" / folder).rglob("*.test.js") if path.relative_to(ROOT).as_posix() != TEST)
    files += ["test/mbt/unit/dispatch-plan-authoritative-projection.red.test.js",
              "test/mbt/unit/scm-dependency-plan-reconciler.red.test.js"]
    results = {}
    for label, replacement in [("baseline-suite", BASELINE), ("current-suite", None)]:
        results[label] = run(label, ["--test", "--test-concurrency=2", *files], replacement)
        print(json.dumps({label: results[label]}), flush=True)
    save("suites.json", {"files": len(files), **results})
    assert results["baseline-suite"]["failures"] == results["current-suite"]["failures"]
    assert results["baseline-suite"]["exitCode"] == results["current-suite"]["exitCode"]


def focused():
    files = [TEST, "test/dispatch/unit/dispatch-po-line-destinations.test.js",
             "test/dispatch/unit/dispatch-po-route-residual.red.test.js",
             "test/dispatch/property/dispatch-po-route-residual.property.test.js",
             "test/dispatch/adversarial/dispatch-po-route-residual-adversarial.test.js",
             "test/dispatch/frontend/dispatch-po-route-residual-ui.red.test.js"]
    result = run("focused", ["node_modules/c8/bin/c8.js", "--all=false", "--check-coverage=false", "--include=" + SOURCE,
                 "--temp-directory=/tmp/group-member-po-c8", "--report-dir=/evidence/coverage",
                 "--reporter=json", "--reporter=text", "node", "--test", "--test-concurrency=1", *files], output=True)
    save("focused.json", result)
    assert result["exitCode"] == 0, result
    shuffled = run("suite-health", ["--test", "--test-concurrency=2", *reversed(files)])
    save("suite-health.json", shuffled)
    assert shuffled["exitCode"] == 0, shuffled
    coverage = json.loads((OUT / "coverage/coverage-final.json").read_text())["/app/" + SOURCE]
    covered = {}
    for key, location in coverage["statementMap"].items():
        for line in range(location["start"]["line"], location["end"]["line"] + 1):
            covered[line] = max(covered.get(line, 0), coverage["s"][key])
    before, after = BASELINE.read_text().splitlines(), (ROOT / SOURCE).read_text().splitlines()
    changed = []
    for tag, _, _, start, end in difflib.SequenceMatcher(a=before, b=after).get_opcodes():
        if tag in ["replace", "insert"]:
            changed += [line + 1 for line in range(start, end) if after[line].strip() and not after[line].lstrip().startswith("//")]
    checks = [{"line": line, "count": covered.get(line, 0)} for line in changed]
    save("changed-line-coverage.json", checks)
    assert all(row["count"] > 0 for row in checks), checks
    print(json.dumps({"focused": result, "suiteHealth": shuffled, "changedLines": len(checks)}), flush=True)


def static():
    results = {}
    for label, replacement in [("baseline", BASELINE), ("current", None)]:
        results[label] = run(label + "-lint", ["node_modules/eslint/bin/eslint.js", "--config", "eslint.mbt.config.js",
                                               "--max-warnings=0", SOURCE, TEST], replacement)
    assert results["baseline"]["exitCode"] == results["current"]["exitCode"]
    # Existing repository diagnostics are compared verbatim; line offsets can move.
    diagnostics = lambda p: [line.split("  ", 1)[-1].strip() for line in p.read_text().splitlines() if " error " in line or " warning " in line]
    assert diagnostics(OUT / "baseline-lint.log") == diagnostics(OUT / "current-lint.log")
    results["typesBaseline"] = run("baseline-types", ["node_modules/typescript/bin/tsc", "--project", "tsconfig.mbt.json"], BASELINE)
    results["types"] = run("types", ["node_modules/typescript/bin/tsc", "--project", "tsconfig.mbt.json"])
    type_lines = lambda path: [re.sub(r"\(\d+,\d+\)", "(line,column)", line) for line in path.read_text().splitlines()]
    assert type_lines(OUT / "baseline-types.log") == type_lines(OUT / "types.log"), "New type diagnostics"
    results["syntax"] = run("syntax", ["--check", SOURCE])
    assert results["syntax"]["exitCode"] == 0
    results["noNewDiagnostics"] = True
    save("static.json", results)
    print(json.dumps(results), flush=True)


def mutations():
    source = (ROOT / SOURCE).read_text()
    mutations = [
        ("omit-child-query", "...targetRefs(order),", "order?.id,"),
        ("omit-child-projection", "targetRefs(order).flatMap((ref) => byTarget.get(ref) || [])", "byTarget.get(String(order?.id).toLowerCase()) || []"),
        ("duplicate-targets", "const targetRefs = (order) => [...new Set([", "const targetRefs = (order) => [...(["),
        ("inherit-split-parent", "order?.id,\n    ...(String(order?.type", "order?.id, order?.originalOrderId,\n    ...(String(order?.type"),
        ("include-co-sources", 'String(order?.type || "").toUpperCase() === "SO" ? [', 'true ? ['),
        ("include-cancelled", "WHERE allocation.status = 'active'\n        AND (\n          lower(allocation.dispatch_target_ref)",
         "WHERE allocation.status IN ('active','cancelled')\n        AND (\n          lower(allocation.dispatch_target_ref)")
    ]
    results = []
    for name, old, new in mutations:
        assert source.count(old) == 1, name
        mutant = OUT / ("mutant-" + name + ".js")
        mutant.write_text(source.replace(old, new))
        result = run("mutation-" + name, ["--test", TEST], mutant)
        results.append({"name": name, "killed": result["exitCode"] != 0, "failures": result["failures"]})
        mutant.unlink()
    save("mutations.json", results)
    assert all(result["killed"] for result in results)
    assert (ROOT / SOURCE).read_text() == source
    print(json.dumps(results), flush=True)


if __name__ == "__main__":
    requested = sys.argv[1:] or ["suites", "static", "focused", "mutations"]
    for step in requested:
        globals()[step]()
    save("source-hashes.json", {name: hashlib.sha256((ROOT / name).read_bytes()).hexdigest() for name in [SOURCE, TEST]})
