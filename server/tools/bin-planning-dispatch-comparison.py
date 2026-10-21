"""Compare remaining Dispatch failures with the new BIN behavior disabled."""
from pathlib import Path
import json
import os
import re
import shutil
import subprocess
import tempfile

root = Path(__file__).resolve().parents[1]
artifact = root / "test-artifacts/mbt-bin-planning/comparison"
artifact.mkdir(parents=True, exist_ok=True)
files = ["test/dispatch/integration/dispatch-v2-command-flow.red.test.js",
         "test/dispatch/integration/dispatch-v2-snapshot-performance.red.test.js",
         "test/dispatch/frontend/dispatch-planner-performance.contract.test.js"]
results = {}
with tempfile.TemporaryDirectory(prefix="bin-planning-comparison-") as temporary:
    copied = Path(temporary)
    for directory in ["src", "public", "test", "migrations", "tools", "contracts"]:
        shutil.copytree(root / directory, copied / directory)
    for file in root.iterdir():
        if file.is_file() and file.suffix in [".json", ".js", ".mjs"]:
            shutil.copy2(file, copied / file.name)
    for file, name, args, body in [
        ("src/mbt/bin-planning-domain.js", "preserveOrdinaryDispatchBins", "previous, next", "return next;"),
        ("src/driver-repository.js", "releasedDriverPlan", "plan", "return plan;")
    ]:
        target = copied / file
        source, count = re.subn(r"^(export )?function " + name + r"\([^\n]*\) \{.*?^\}",
                               lambda match: (match.group(1) or "") + f"function {name}({args}) {{ {body} }}",
                               target.read_text(), count=1, flags=re.M | re.S)
        assert count == 1
        target.write_text(source)
    for label, source in [("current", root), ("bin-behavior-disabled", copied)]:
        env = dict(os.environ, BIN_PLANNING_CHECK=f"comparison-{label}", BIN_PLANNING_SOURCE_ROOT=str(source))
        log = artifact / f"{label}.log"
        with log.open("w") as output:
            completed = subprocess.run(["bash", str(root / "tools/bin-planning-test.sh"), "node",
                                        "tools/bin-planning-suites.mjs", "selected", *files],
                                       cwd=root.parent, env=env, stdout=output, stderr=subprocess.STDOUT, timeout=300)
        failures = sorted(set(re.findall(r"^✖ (.+?) \([\d.]+ms\)$", log.read_text(), flags=re.M)))
        results[label] = dict(exit_code=completed.returncode, failures=failures)
        print(f"{label}: {len(failures)} failing assertions", flush=True)
assert results["current"]["failures"] == results["bin-behavior-disabled"]["failures"]
assert len(results["current"]["failures"]) == 4
assert results["current"]["exit_code"] == results["bin-behavior-disabled"]["exit_code"] == 1
(artifact / "results.json").write_text(json.dumps(results, indent=2))
print("The same four assertions fail with BIN behavior disabled; no change to their expectations.")
