"""One entry point for isolated BIN planning verification. No deployment."""
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
import hashlib
import json
import os
import re
import subprocess
from datetime import datetime, timezone

root = Path(__file__).resolve().parents[1]
out = root / "test-artifacts/bin-planner-reuse/final"
out.mkdir(parents=True, exist_ok=True)
started_at = datetime.now(timezone.utc).isoformat()
files = json.loads((root / "tools/bin-planner-reuse-files.json").read_text())
initial_hashes = {file: hashlib.sha256((root / file).read_bytes()).hexdigest() for file in files}
checks = {
    "coverage": ["node", "tools/bin-planning-coverage.mjs"],
    "compatibility": ["node", "tools/bin-planning-suites.mjs", "baseline"],
    "dispatch": ["node", "tools/bin-planning-suites.mjs", "dispatch"],
    "repair": ["node", "--test", "test/dispatch/integration/dispatch-retired-confirm-repair.test.js"],
    "static": ["node", "tools/bin-planner-reuse-static.mjs"],
    "secrets": ["node", "tools/bin-planner-reuse-secrets.mjs"],
    "reverse": ["node", "tools/bin-planning-suites.mjs", "feature", "reverse"],
}
def run_check(name, arguments):
    env = dict(os.environ, BIN_PLANNING_CHECK=f"reuse-final-{name}")
    with (out / f"{name}.log").open("w") as output:
        result = subprocess.run(["bash", str(root / "tools/bin-planning-test.sh"), *arguments], cwd=root.parent,
                                env=env, stdout=output, stderr=subprocess.STDOUT, timeout=900)
    print(f"{name}: exit {result.returncode}", flush=True)
    return name, result.returncode

results = {}
with ThreadPoolExecutor(max_workers=2) as executor:
    pending = [executor.submit(run_check, name, args) for name, args in checks.items()]
    for future in as_completed(pending):
        name, code = future.result()
        results[name] = code
for name, file in [("mutations", "bin-planner-reuse-mutations.py")]:
    with (out / f"{name}.log").open("w") as output:
        result = subprocess.run(["python3", str(root / "tools" / file)], cwd=root.parent,
                                stdout=output, stderr=subprocess.STDOUT, timeout=900)
    results[name] = result.returncode
    print(f"{name}: exit {result.returncode}", flush=True)

# Recorded in test/mbt-bin-planning-evidence.md before this correction.
expected = ['DP-11 and DP-12: targeted CO and atomic split commands return only affected records and exact retries', 'DP-13 and DP-16: checkpoint list is metadata-only and compact reads/commands record bounded timings', 'DP-33 frontend: active CO projection retains every current relationship pickup', 'history search reveals reconciliation-complete PO/SO orders but never Driver PWA-completed orders']
actual = sorted(set(re.findall(r"^✖ (.+?) \([\d.]+ms\)$", (out / "dispatch.log").read_text(), flags=re.M)))
unexpected = {name: code for name, code in results.items() if code and name != "dispatch"}
if actual != expected:
    unexpected["dispatch_new_failures"] = actual
dispatch_log = (out / "dispatch.log").read_text()
if (results["dispatch"] != 1 or len(re.findall(r"^ℹ tests \d+$", dispatch_log, re.M)) != 37
        or sum(map(int, re.findall(r"^ℹ fail (\d+)$", dispatch_log, re.M))) != 4
        or "Isolated bin-planning-dispatch run failed in 3/37 file(s):" not in dispatch_log):
    unexpected["dispatch_incomplete_or_unexpected_status"] = results["dispatch"]
hashes = {file: hashlib.sha256((root / file).read_bytes()).hexdigest() for file in files}
if hashes != initial_hashes:
    unexpected["source_changed_during_run"] = [file for file in files if hashes[file] != initial_hashes[file]]
tree_hash = hashlib.sha256(json.dumps(hashes, sort_keys=True).encode()).hexdigest()
report = dict(checks=results, unchanged_dispatch_failures=actual, unexpected_failures=unexpected,
              started_at=started_at, finished_at=datetime.now(timezone.utc).isoformat(),
              source_tree_sha256=tree_hash, files=hashes)
(out / "result.json").write_text(json.dumps(report, indent=2))
print(json.dumps({key: value for key, value in report.items() if key != "files"}, indent=2))
raise SystemExit(1 if unexpected else 0)
